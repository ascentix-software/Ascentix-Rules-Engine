import { createDevApi, deleteDevRecord } from "../devApi";
import { ENTITY_SET, BIND_NAV } from "../../src/editor/load/odata";
import { configsVisible, enforcementSettled } from "./settle";

// The reusable ZZ_RB_ authoring core for the rule-behavior server suite. Builds a shared
// table-config node graph mirroring the sample Order -> Customer/Line/Product shape, and
// assembles + validates a real, Published rule against it. Every created record self-cleans via
// the returned `cleanup()`: it drains on any mid-author failure, and callers drain again after
// use. `sweep.ts` is the crash-recovery backstop for orphaned ZZ_RB_ rows.

interface TrackedRecord {
  set: string;
  id: string;
}

async function deleteInReverse(created: TrackedRecord[]): Promise<void> {
  const rule = created.find(rec => rec.set === ENTITY_SET.rule);
  if (rule) {
    await deleteDevRecord(rule.set, rule.id);
    created.length = 0;
    return;
  }
  while (created.length) {
    const rec = created[created.length - 1];
    await deleteDevRecord(rec.set, rec.id);
    created.pop();
  }
}

export interface TableConfigGraph {
  order: string;
  customer: string;
  parent: string;
  line: string;
  product: string;
  shipment: string;
  cleanup: () => Promise<void>;
}

// Builds the shared ZZ_RB_TC_* node graph: Order (root) -> Customer (lookup) -> ParentCustomer
// (self-ref lookup), Order -> OrderLine (child) -> Product (lookup). Tracked for cleanup in
// creation order; `cleanup()` deletes in reverse (product, line, parent, customer, order) so
// children never outlive the parent they point at.
export async function ensureTableConfig(): Promise<TableConfigGraph> {
  const api = createDevApi();
  const created: TrackedRecord[] = [];

  async function createNode(data: Record<string, unknown>): Promise<string> {
    const id = await api.createRecord(ENTITY_SET.tableConfig, data);
    created.push({ set: ENTITY_SET.tableConfig, id });
    return id;
  }

  try {
    const order = await createNode({
      asx_name: "ZZ_RB_TC_order",
      asx_tablelogicalname: "sample_order",
      asx_tableconfigtype: 1, // Root
    });
    const customer = await createNode({
      asx_name: "ZZ_RB_TC_customer",
      asx_tablelogicalname: "sample_customer",
      asx_tableconfigtype: 2, // Lookup
      asx_lookupcolumnlogicalname: "sample_customerid",
      // Required on every LookupTable node (docs/Schema.md, Table Config, asx_lookuptargetidattribute): the target table's own
      // primary-id attribute, used to batch-load lookup targets. Confirmed live via
      // EntityDefinitions(LogicalName='sample_customer')/PrimaryIdAttribute == sample_customerid.
      asx_lookuptargetidattribute: "sample_customerid",
      [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${order})`,
    });
    const parent = await createNode({
      asx_name: "ZZ_RB_TC_parent",
      asx_tablelogicalname: "sample_customer",
      asx_tableconfigtype: 2, // Lookup (self-ref)
      asx_lookupcolumnlogicalname: "sample_parentcustomerid",
      asx_lookuptargetidattribute: "sample_customerid", // self-ref: same target table as `customer`
      [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${customer})`,
    });
    const line = await createNode({
      asx_name: "ZZ_RB_TC_line",
      asx_tablelogicalname: "sample_orderline",
      asx_tableconfigtype: 3, // Child
      asx_childlinkfield: "sample_orderid",
      [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${order})`,
    });
    const product = await createNode({
      asx_name: "ZZ_RB_TC_product",
      asx_tablelogicalname: "sample_product",
      asx_tableconfigtype: 2, // Lookup
      asx_lookupcolumnlogicalname: "sample_productid",
      // Confirmed live via EntityDefinitions(LogicalName='sample_product')/PrimaryIdAttribute.
      asx_lookuptargetidattribute: "sample_productid",
      [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${line})`,
    });

    const shipment = await createNode({
      asx_name: "ZZ_RB_TC_shipment",
      asx_tablelogicalname: "sample_shipment",
      asx_tableconfigtype: 3, // Child (sibling collection of line, under order)
      asx_childlinkfield: "sample_orderid",
      [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${order})`,
    });

    await awaitConfigsVisible([order, customer, parent, line, product, shipment]);
    return { order, customer, parent, line, product, shipment, cleanup: () => deleteInReverse(created) };
  } catch (err) {
    await deleteInReverse(created).catch(cleanupError => console.warn("Fixture cleanup failed:", cleanupError));
    throw err;
  }
}

// A freshly created asx_tableconfig row is not immediately visible to the engine's id-filtered
// RetrieveMultiple over that table (settle.ts configsVisible, the config-tree settle; 60s cap).
async function awaitConfigsVisible(ids: string[], capMs = 60000): Promise<void> {
  await configsVisible(ids, capMs);
}

export interface LineRootedGraph {
  lineRoot: string;   // sample_orderline (Root), the table the rule triggers on
  order: string;      // sample_order (Lookup off the line)
  siblings: string;   // sample_orderline (Child of that order), includes the triggering line
  cleanup: () => Promise<void>;
}

// The "root is one of the rows I aggregate over" shape: Order Line (root) -> Order (lookup) ->
// Order Lines (child collection). Because enforcement runs pre-operation, this is the shape where
// the traversal re-reads the very table being written, and the engine has to reconcile the fetch
// with the unsaved operation (Core/Execution/InFlightReconciler.cs). Kept separate from
// ensureTableConfig's order-rooted graph: a rule's root node fixes its trigger table.
export async function ensureLineRootedConfig(): Promise<LineRootedGraph> {
  const api = createDevApi();
  const created: TrackedRecord[] = [];

  async function createNode(data: Record<string, unknown>): Promise<string> {
    const id = await api.createRecord(ENTITY_SET.tableConfig, data);
    created.push({ set: ENTITY_SET.tableConfig, id });
    return id;
  }

  try {
    const lineRoot = await createNode({
      asx_name: "ZZ_RB_TC_lineroot",
      asx_tablelogicalname: "sample_orderline",
      asx_tableconfigtype: 1, // Root
    });
    const order = await createNode({
      asx_name: "ZZ_RB_TC_lineroot_order",
      asx_tablelogicalname: "sample_order",
      asx_tableconfigtype: 2, // Lookup
      asx_lookupcolumnlogicalname: "sample_orderid",
      asx_lookuptargetidattribute: "sample_orderid",
      [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${lineRoot})`,
    });
    const siblings = await createNode({
      asx_name: "ZZ_RB_TC_lineroot_siblings",
      asx_tablelogicalname: "sample_orderline",
      asx_tableconfigtype: 3, // Child
      asx_childlinkfield: "sample_orderid",
      [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${order})`,
    });

    await awaitConfigsVisible([lineRoot, order, siblings]);
    return { lineRoot, order, siblings, cleanup: () => deleteInReverse(created) };
  } catch (err) {
    await deleteInReverse(created).catch(cleanupError => console.warn("Fixture cleanup failed:", cleanupError));
    throw err;
  }
}

export interface ConditionCfg {
  nodeId: string; // the node this condition evaluates on (from ensureTableConfig)
  conditionType: number; // 1 FieldComparison | 2 RowCount | 3 RegexMatch | 4 Expression
  column?: string; // FieldComparison LHS column; RegexMatch target column
  operator?: number; // comparison operator enum (FieldComparison / Expression)
  valueSource?: number; // 1 Literal | 2 FieldReference
  literal?: string; // asx_comparisonvalue payload: Literal (src 1) / Template string (src 3) / DateExpression JSON (src 4); RegexMatch pattern; Expression literal RHS
  valueColumn?: string; // FieldReference RHS column (source 2)
  valueNodeId?: string; // FieldReference RHS node (source 2) -> asx_ComparisonValueNode
  minRows?: number; // RowCount asx_minexpectedrows
  maxRows?: number; // RowCount asx_maxexpectedrows
  expression?: string; // Expression (Calculation, type 4): asx_conditionexpression (mathexpr LHS)
  nodeFilter?: {
    // "Only consider records where…": one flat AND asx_nodefiltergroup on targetNodeId.
    targetNodeId: string; // asx_tableconfignode, the node whose rows are filtered
    criteria: Array<{
      fieldName?: string;
      operator?: string; // TEXT token: eq/ne/gt/ge/lt/le/like/not-like/null/not-null/contains/not-contains
      value?: string; // literal RHS
      valueSource?: number; // 1 Literal (default) | 2 FieldReference
      valueColumn?: string; // FieldReference RHS column
      valueNodeId?: string; // FieldReference RHS node (asx_comparisonvaluenode); omit ⇒ same record
      exists?: {
        // EXISTS criterion (criteriontype 2): the target's related collection has min..max rows
        // matching the sub-filter. Sub-filter group hangs off the criterion (owningcriterion).
        collectionNodeId: string;
        minCount?: number;
        maxCount?: number;
        sub: Array<{ fieldName: string; operator: string; value?: string }>;
      };
    }>;
  };
}

export interface ActionCfg {
  actionType: number; // 1 SetVisible | 2 SetRequired | 3 ShowMessage | 4 Block
  fireOn: number; // 1 OnMatch | 2 OnNoMatch
  targetColumn?: string; // SetVisible/SetRequired target; field-level Block; omit for form-level
  valueBool?: boolean; // SetVisible/SetRequired: asx_valuebool (show / required when true)
  message?: string; // ShowMessage / Block text (not used by SetVisible/SetRequired)
  severity?: number; // 1 Information | 2 Warning | 3 Error
  targetTable?: string; // CreateRecord: asx_targettable (logical name, singular)
  targetNodeId?: string; // Update/Delete: asx_TargetNode @odata.bind (single-cardinality node)
  fieldMapping?: string; // Create/Update: asx_fieldmapping JSON string
}

export interface RuleConfig {
  name: string; // will be prefixed ZZ_RB_ if not already
  rootNodeId: string; // the order root node
  tableLogicalName?: string; // asx_tablelogicalname; default "sample_order" (must match rootNodeId's table)
  triggers?: string; // default "1,2,4" (OnCreate,OnForm,OnUpdate)
  channels?: number[]; // asx_channels (1 Standard | 2 Portal); empty/omitted ⇒ all channels
  groupOp?: number; // 1 And (default) | 2 Or
  conditions: ConditionCfg[];
  actions: ActionCfg[];
  publish?: boolean; // default true; false leaves the rule Draft (e2e specs publish via the UI)
  requireValid?: boolean; // default true; false skips the asx_ValidateRule gate (e2e invalid-rule fixtures)
  settleProbe?: () => Promise<boolean>; // post-publish enforcement settle (see awaitEnforcement)
  evaluationContext?: number; // asx_evaluationcontext: 1 User (default) | 2 System
}

// Enforcement settle: repeat a sacrificial violating probe until the block is observed (the
// publish transaction writes the step row; the pipeline cache that runs it propagates
// asynchronously). Adapter over settle.ts enforcementSettled: same 1s interval / 30s cap /
// message. A dead rule still fails: at this step, with this message, not in the real assertions.
export async function awaitEnforcement(
  probe: () => Promise<boolean>, // true = enforcement observed
  opts: { label?: string; intervalMs?: number; capMs?: number } = {},
): Promise<void> {
  await enforcementSettled(probe, opts);
}

export interface AuthoredRule {
  ruleId: string;
  ruleName: string;
  cleanup: () => Promise<void>;
}

// Assembles a rule + one exec group + its conditions + actions, then validates via
// asx_ValidateRule before returning: the engine only enforces a valid Published rule, so a rule
// this function returns is guaranteed structurally sound. Any failure along the way (create 400,
// or a failed validate) drains everything created so far and rethrows.
export async function authorRule(cfg: RuleConfig): Promise<AuthoredRule> {
  const api = createDevApi();
  const created: TrackedRecord[] = [];

  try {
    const ruleName = cfg.name.startsWith("ZZ_RB_") ? cfg.name : `ZZ_RB_${cfg.name}`;

    const ruleId = await api.createRecord(ENTITY_SET.rule, {
      asx_name: ruleName,
      asx_tablelogicalname: cfg.tableLogicalName ?? "sample_order",
      // No statuscode here: the rule is born Draft, exactly like the editor's createRule
      // (client/src/editor/save/operations.ts). Published happens later via publishRule below.
      asx_triggers: cfg.triggers ?? "1,2,4",
      // Multi-select choice: Web API wants a comma-separated string of the int values. Empty ⇒ omit ⇒ all channels.
      ...(cfg.channels && cfg.channels.length ? { asx_channels: cfg.channels.join(",") } : {}),
      ...(cfg.evaluationContext ? { asx_evaluationcontext: cfg.evaluationContext } : {}),
      [`${BIND_NAV.ruleRootTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${cfg.rootNodeId})`,
    });
    created.push({ set: ENTITY_SET.rule, id: ruleId });

    const groupId = await api.createRecord(ENTITY_SET.group, {
      asx_name: `${ruleName}_g`,
      asx_logicaloperator: cfg.groupOp ?? 1, // And
      asx_isexecutioncondition: false,
      [`${BIND_NAV.groupRule}@odata.bind`]: `/${ENTITY_SET.rule}(${ruleId})`,
    });
    created.push({ set: ENTITY_SET.group, id: groupId });

    for (let i = 0; i < cfg.conditions.length; i++) {
      const c = cfg.conditions[i];
      const data: Record<string, unknown> = {
        asx_name: `${ruleName}_c${i + 1}`,
        asx_conditiontype: c.conditionType,
        [`${BIND_NAV.conditionGroup}@odata.bind`]: `/${ENTITY_SET.group}(${groupId})`,
        [`${BIND_NAV.conditionTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${c.nodeId})`,
      };
      if (c.conditionType === 1) {
        // FieldComparison
        data.asx_comparisoncolumn = c.column;
        data.asx_comparisonoperator = c.operator;
        data.asx_comparisonvaluesource = c.valueSource;
        if (c.valueSource === 1 || c.valueSource === 3 || c.valueSource === 4) {
          // Literal (1), Template (3) string, or DateExpression (4) JSON: all live in asx_comparisonvalue.
          data.asx_comparisonvalue = c.literal;
        } else if (c.valueSource === 2) {
          data.asx_comparisonvaluecolumn = c.valueColumn;
          if (c.valueNodeId) {
            data[`${BIND_NAV.conditionValueNode}@odata.bind`] = `/${ENTITY_SET.tableConfig}(${c.valueNodeId})`;
          }
        }
      } else if (c.conditionType === 2) {
        // RowCount
        data.asx_minexpectedrows = c.minRows;
        if (c.maxRows !== undefined) data.asx_maxexpectedrows = c.maxRows;
        data.asx_comparisonvaluesource = 1;
      } else if (c.conditionType === 3) {
        // RegexMatch: asx_comparisoncolumn tested against the pattern in asx_comparisonvalue.
        data.asx_comparisoncolumn = c.column;
        data.asx_comparisonvalue = c.literal; // the regex pattern
      } else if (c.conditionType === 4) {
        // Expression (Calculation): mathexpr LHS vs a literal numeric RHS.
        data.asx_conditionexpression = c.expression;
        data.asx_comparisonoperator = c.operator;
        data.asx_comparisonvaluesource = 1; // Literal RHS
        data.asx_comparisonvalue = c.literal;
      }
      const conditionId = await api.createRecord(ENTITY_SET.condition, data);
      created.push({ set: ENTITY_SET.condition, id: conditionId });

      if (c.nodeFilter) {
        const fgId = await api.createRecord(ENTITY_SET.nodeFilterGroup, {
          asx_logicaloperator: 1, // And
          [`${BIND_NAV.filterGroupConditionGroup}@odata.bind`]: `/${ENTITY_SET.group}(${groupId})`,
          [`${BIND_NAV.filterGroupCondition}@odata.bind`]: `/${ENTITY_SET.condition}(${conditionId})`,
          [`${BIND_NAV.filterGroupTargetNode}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${c.nodeFilter.targetNodeId})`,
        });
        created.push({ set: ENTITY_SET.nodeFilterGroup, id: fgId });
        for (const crit of c.nodeFilter.criteria) {
          if (crit.exists) {
            const ex = crit.exists;
            const exCritId = await api.createRecord(ENTITY_SET.nodeFilterCriterion, {
              asx_criteriontype: 2, // Exists
              asx_mincount: ex.minCount,
              ...(ex.maxCount !== undefined ? { asx_maxcount: ex.maxCount } : {}),
              [`${BIND_NAV.filterCriterionGroup}@odata.bind`]: `/${ENTITY_SET.nodeFilterGroup}(${fgId})`,
              [`${BIND_NAV.filterCriterionCollectionNode}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${ex.collectionNodeId})`,
            });
            created.push({ set: ENTITY_SET.nodeFilterCriterion, id: exCritId });
            // Sub-filter group owned by the Exists criterion (NOT scoped to the condition group).
            const subFgId = await api.createRecord(ENTITY_SET.nodeFilterGroup, {
              asx_logicaloperator: 1, // And
              [`${BIND_NAV.filterGroupOwningCriterion}@odata.bind`]: `/${ENTITY_SET.nodeFilterCriterion}(${exCritId})`,
            });
            created.push({ set: ENTITY_SET.nodeFilterGroup, id: subFgId });
            for (const sc of ex.sub) {
              const scId = await api.createRecord(ENTITY_SET.nodeFilterCriterion, {
                asx_fieldname: sc.fieldName,
                asx_operator: sc.operator,
                asx_criteriontype: 1, // Comparison
                asx_value: sc.value,
                [`${BIND_NAV.filterCriterionGroup}@odata.bind`]: `/${ENTITY_SET.nodeFilterGroup}(${subFgId})`,
              });
              created.push({ set: ENTITY_SET.nodeFilterCriterion, id: scId });
            }
          } else {
            const critData: Record<string, unknown> = {
              asx_fieldname: crit.fieldName,
              asx_operator: crit.operator,
              asx_criteriontype: 1, // Comparison
              [`${BIND_NAV.filterCriterionGroup}@odata.bind`]: `/${ENTITY_SET.nodeFilterGroup}(${fgId})`,
            };
            if ((crit.valueSource ?? 1) === 2) {
              critData.asx_comparisonvaluesource = 2; // FieldReference
              critData.asx_comparisonvaluecolumn = crit.valueColumn;
              if (crit.valueNodeId)
                critData[`${BIND_NAV.filterCriterionValueNode}@odata.bind`] = `/${ENTITY_SET.tableConfig}(${crit.valueNodeId})`;
            } else {
              critData.asx_value = crit.value;
            }
            const critId = await api.createRecord(ENTITY_SET.nodeFilterCriterion, critData);
            created.push({ set: ENTITY_SET.nodeFilterCriterion, id: critId });
          }
        }
      }
    }

    for (let i = 0; i < cfg.actions.length; i++) {
      const a = cfg.actions[i];
      const data: Record<string, unknown> = {
        asx_name: `${ruleName}_a${i + 1}`,
        asx_actiontype: a.actionType,
        asx_fireon: a.fireOn,
        asx_order: 1,
        asx_isactive: true,
        ...(a.targetColumn ? { asx_targetcolumn: a.targetColumn } : {}),
        ...(a.valueBool !== undefined ? { asx_valuebool: a.valueBool } : {}),
        ...(a.message !== undefined ? { asx_message: a.message } : {}),
        ...(a.severity ? { asx_severity: a.severity } : {}),
        ...(a.targetTable ? { asx_targettable: a.targetTable } : {}),
        ...(a.fieldMapping !== undefined ? { asx_fieldmapping: a.fieldMapping } : {}),
        ...(a.targetNodeId
          ? { [`${BIND_NAV.actionTargetNode}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${a.targetNodeId})` }
          : {}),
        [`${BIND_NAV.actionRule}@odata.bind`]: `/${ENTITY_SET.rule}(${ruleId})`,
      };
      const actionId = await api.createRecord(ENTITY_SET.action, data);
      created.push({ set: ENTITY_SET.action, id: actionId });
    }

    // Validate before publishing: reaching this point proves the rule is structurally sound.
    // requireValid:false is for e2e fixtures that WANT an invalid/incomplete rule.
    if (cfg.requireValid ?? true) {
      const v = await api.validateRule(ruleId);
      if (!v.isValid) {
        throw new Error(`authorRule: rule invalid: ${JSON.stringify(v.issues)}`);
      }
    }

    // The editor creates a rule Draft then publishes via a statuscode UPDATE;
    // RuleRegistrationPlugin registers RulesEnginePlugin's enforcement steps on that publish
    // UPDATE, over the committed rule+action graph. So authorRule mirrors the editor exactly:
    // create Draft -> validate -> publishRule.
    //
    // That registration path was itself a real engine bug until the effective-state overlay fix
    // shipped: RuleRegistrationPlugin is pre-operation and
    // re-queried committed statuscode==Published, so it could not see the publish UPDATE's own
    // in-flight Draft->Published flip: a freshly-published rule silently never enforced. The fix
    // overlays the in-flight Target/pre-image so the publish registers within its own
    // transaction. This suite's Block cases passing live are the real-org proof of that fix.
    if (cfg.publish ?? true) {
      await api.publishRule(ruleId);
      if (cfg.settleProbe) await awaitEnforcement(cfg.settleProbe, { label: ruleName });
    }

    return { ruleId, ruleName, cleanup: () => deleteInReverse(created) };
  } catch (err) {
    await deleteInReverse(created).catch(cleanupError => console.warn("Fixture cleanup failed:", cleanupError));
    throw err;
  }
}
