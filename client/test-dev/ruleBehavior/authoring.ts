import type { EditorApi } from "../../src/editor/webapi";
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

export interface AccountSetGraph { account: string; contacts: string; tasks: string; cleanup: () => Promise<void>; }

// account (root) → contacts (child, parentcustomerid) → tasks (child of contact, regardingobjectid).
// The set-action shape (spec §1.1): a two-level child collection off a standard-entity root, for
// ruleBehaviorSetActions.dev.test.ts's account-keeps-contacts-and-tasks-in-step scenario.
export async function ensureAccountSetConfig(): Promise<AccountSetGraph> {
  const api = createDevApi();
  const created: TrackedRecord[] = [];
  async function createNode(data: Record<string, unknown>): Promise<string> {
    const id = await api.createRecord(ENTITY_SET.tableConfig, data);
    created.push({ set: ENTITY_SET.tableConfig, id });
    return id;
  }
  try {
    const account = await createNode({ asx_name: "ZZ_RB_TC_set_account", asx_tablelogicalname: "account", asx_tableconfigtype: 1 });
    const contacts = await createNode({ asx_name: "ZZ_RB_TC_set_contacts", asx_tablelogicalname: "contact", asx_tableconfigtype: 3,
      asx_childlinkfield: "parentcustomerid", [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${account})` });
    const tasks = await createNode({ asx_name: "ZZ_RB_TC_set_tasks", asx_tablelogicalname: "task", asx_tableconfigtype: 3,
      asx_childlinkfield: "regardingobjectid", [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${contacts})` });
    await awaitConfigsVisible([account, contacts, tasks]);
    return { account, contacts, tasks, cleanup: () => deleteInReverse(created) };
  } catch (err) {
    await deleteInReverse(created).catch((e) => console.warn("Fixture cleanup failed:", e));
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
  expressionFilters?: string; // Expression (Calculation): asx_expressionfilters JSON map
  nodeFilter?: {
    // "Only consider records where…": one flat AND asx_nodefiltergroup on targetNodeId.
    targetNodeId: string; // asx_tableconfignode, the node whose rows are filtered
    criteria: Array<{
      fieldName?: string;
      operator?: string; // TEXT token: eq/ne/gt/ge/lt/le/like/not-like/null/not-null/contains/not-contains
      value?: string; // literal RHS
      valueSource?: number; // 1 Literal (default) | 2 FieldReference | 4 DateExpression (JSON in value)
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

// An action's "Fires when" tree (docs/Schema.md 2.18-2.19). A test names an outcome (a top-level
// validation group of the rule, RuleConfig.outcomes[].name, or `${ruleName}_g` for the single
// default group) and the value it must have; a node is ALL (`all`) or ANY (`any`) of its children.
export type WhenTest = { outcome: string; is: boolean };
export type WhenCfg = { all?: (WhenTest | WhenCfg)[]; any?: (WhenTest | WhenCfg)[] };

export interface ActionCfg {
  actionType: number; // 1 SetVisible | 2 SetRequired | 3 ShowMessage | 4 Block
  // Shorthand for the retired On match / On no match, translated to a Fires-when tree with the
  // migration's mapping (migrations/2026-10-multi-outcome): 1 -> root ALL with every outcome "is
  // true" (no outcomes -> empty ALL); 2 -> root ANY with every outcome "is false". 2 with no
  // outcomes would never fire, so the helper throws. Ignored when `when` is given.
  fireOn?: number; // 1 | 2
  when?: WhenCfg; // explicit Fires-when tree; neither `when` nor `fireOn` -> Always (empty root ALL)
  targetColumn?: string; // SetVisible/SetRequired target; field-level Block; omit for form-level
  valueBool?: boolean; // SetVisible/SetRequired: asx_valuebool (show / required when true)
  message?: string; // ShowMessage / Block text (not used by SetVisible/SetRequired)
  severity?: number; // 1 Information | 2 Warning | 3 Error
  targetTable?: string; // CreateRecord: asx_targettable (logical name, singular)
  targetNodeId?: string; // Update/Delete/Deactivate/CreateRecord: asx_TargetNode @odata.bind — a
  // single-cardinality node (root/lookup: writes that one record), or a collection node (writes
  // every filtered row: a set action, docs/Schema.md §2.9/§4)
  fieldMapping?: string; // Create/Update: asx_fieldmapping JSON string
  applyToPrevious?: boolean; // Update Record: asx_applytoprevious
  order?: number; // asx_order: dispatch order among the actions that fire (default 1)
  // a set action's Rows filter: one AND group on targetNodeId (asx_RuleAction bind), criteria like ConditionCfg.nodeFilter
  rowFilter?: {
    criteria: Array<{
      fieldName?: string;
      operator?: string; // TEXT token: eq/ne/gt/ge/lt/le/like/not-like/null/not-null/contains/not-contains
      value?: string;
      exists?: {
        collectionNodeId: string;
        minCount?: number;
        maxCount?: number;
        sub: Array<{ fieldName: string; operator: string; value?: string }>;
      };
    }>;
  };
}

export interface RuleConfig {
  name: string; // will be prefixed ZZ_RB_ if not already
  rootNodeId: string; // the order root node
  tableLogicalName?: string; // asx_tablelogicalname; default "sample_order" (must match rootNodeId's table)
  triggers?: string; // default "1,2,4" (OnCreate,OnForm,OnUpdate)
  channels?: number[]; // asx_channels (1 Standard | 2 Portal); empty/omitted ⇒ all channels
  groupOp?: number; // 1 And (default) | 2 Or
  conditions: ConditionCfg[];
  // Named outcomes (top-level validation groups). When given, replaces the single `conditions` group
  // (which is ignored); each is created named exactly `name`, and actions' `when` trees refer to it.
  outcomes?: { name: string; groupOp?: 1 | 2; conditions: ConditionCfg[] }[];
  token?: string; // authors as this principal (e.g. the Author-only SP) instead of the az user; cleanup still runs as the az user
  executionConditions?: ConditionCfg[]; // rule gate (asx_isexecutioncondition=true), its own group evaluated before `conditions` (docs/Schema.md §2.3)
  actions: ActionCfg[];
  publish?: boolean; // default true; false leaves the rule Draft (e2e specs publish via the UI)
  requireValid?: boolean; // default true; false skips the asx_ValidateRule gate (e2e invalid-rule fixtures)
  settleProbe?: () => Promise<boolean>; // post-publish enforcement settle (see awaitEnforcement)
  settleConsecutive?: number; // consecutive successful probes required (default 1)
  evaluationContext?: number; // asx_evaluationcontext: 1 User (default) | 2 System
  evaluationTimeZone?: string; // asx_evaluationtimezone: Windows time zone id (blank = UTC)
  onDemandScope?: number; // asx_ondemandscope: 1 Given record (default) | 2 All records that pass its execution conditions; On demand rules only
}

// Enforcement settle: repeat a sacrificial violating probe until the block is observed (the
// publish transaction writes the step row; the pipeline cache that runs it propagates
// asynchronously). Adapter over settle.ts enforcementSettled: same 1s interval / 30s cap /
// message. A dead rule still fails: at this step, with this message, not in the real assertions.
export async function awaitEnforcement(
  probe: () => Promise<boolean>, // true = enforcement observed
  opts: { label?: string; intervalMs?: number; capMs?: number; consecutive?: number } = {},
): Promise<void> {
  await enforcementSettled(probe, opts);
}

export interface AuthoredRule {
  ruleId: string;
  ruleName: string;
  cleanup: () => Promise<void>;
}

type FilterCriteriaCfg = NonNullable<ConditionCfg["nodeFilter"]>["criteria"];

// Creates the criteria (Comparison or Exists, with a nested sub-filter group for Exists) of one
// already-created `asx_nodefiltergroup` (`fgId`). Shared by a condition's nodeFilter ("Only
// consider records where…") and an action's rowFilter (Rows filter): both are one flat AND group
// with the same criterion shape, just parented to a different owner (the condition group vs. the
// action, via BIND_NAV.filterGroupCondition vs. BIND_NAV.filterGroupAction).
async function createFilterCriteria(
  api: EditorApi,
  fgId: string,
  criteria: FilterCriteriaCfg,
  created: TrackedRecord[],
): Promise<void> {
  for (const crit of criteria) {
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
      } else if (crit.valueSource === 4) {
        critData.asx_comparisonvaluesource = 4; // DateExpression
        critData.asx_value = crit.value;
      } else {
        critData.asx_value = crit.value;
      }
      const critId = await api.createRecord(ENTITY_SET.nodeFilterCriterion, critData);
      created.push({ set: ENTITY_SET.nodeFilterCriterion, id: critId });
    }
  }
}

// Assembles a rule + one exec group + its conditions + actions, then validates via
// asx_ValidateRule before returning: the engine only enforces a valid Published rule, so a rule
// this function returns is guaranteed structurally sound. Any failure along the way (create 400,
// or a failed validate) drains everything created so far and rethrows.
export async function authorRule(cfg: RuleConfig): Promise<AuthoredRule> {
  const api = createDevApi(cfg.token);
  const created: TrackedRecord[] = [];

  // Creates one asx_rulecondition (+ any node filter) per entry in `conditions`, all parented to
  // `groupId`, named `${namePrefix}<n>`. Shared by the validation group and an optional
  // execution-condition gate group (RuleConfig.executionConditions) below.
  async function addConditions(groupId: string, conditions: ConditionCfg[], namePrefix: string): Promise<void> {
    for (let i = 0; i < conditions.length; i++) {
      const c = conditions[i];
      const data: Record<string, unknown> = {
        asx_name: `${namePrefix}${i + 1}`,
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
        if (c.expressionFilters) data.asx_expressionfilters = c.expressionFilters;
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
        await createFilterCriteria(api, fgId, c.nodeFilter.criteria, created);
      }
    }
  }

  const ruleName = cfg.name.startsWith("ZZ_RB_") ? cfg.name : `ZZ_RB_${cfg.name}`;
  let ruleId = "";
  const outcomes: { name: string; id: string }[] = [];

  async function createValidationGroup(name: string, op: number): Promise<string> {
    const id = await api.createRecord(ENTITY_SET.group, {
      asx_name: name,
      asx_logicaloperator: op,
      asx_isexecutioncondition: false,
      [`${BIND_NAV.groupRule}@odata.bind`]: `/${ENTITY_SET.rule}(${ruleId})`,
    });
    created.push({ set: ENTITY_SET.group, id });
    return id;
  }

  // One node of an action's Fires-when tree. Every node (not just the root) is bound to the action
  // (asx_RuleAction) so one query loads the whole tree; nested nodes also bind asx_ParentGroup.
  async function createFiresWhenGroup(actionId: string, op: number, order: number, parentId?: string): Promise<string> {
    const id = await api.createRecord(ENTITY_SET.actionConditionGroup, {
      asx_logicaloperator: op,
      asx_order: order,
      [`${BIND_NAV.actionConditionGroupAction}@odata.bind`]: `/${ENTITY_SET.action}(${actionId})`,
      ...(parentId
        ? { [`${BIND_NAV.actionConditionGroupParent}@odata.bind`]: `/${ENTITY_SET.actionConditionGroup}(${parentId})` }
        : {}),
    });
    created.push({ set: ENTITY_SET.actionConditionGroup, id });
    return id;
  }

  async function createFiresWhenTest(groupId: string, outcomeName: string, expected: boolean, order: number): Promise<void> {
    const outcome = outcomes.find(o => o.name === outcomeName);
    if (!outcome)
      throw new Error(`authorRule: a Fires-when test names outcome "${outcomeName}", which this rule does not have (outcomes: ${outcomes.map(o => o.name).join(", ")}).`);
    const id = await api.createRecord(ENTITY_SET.actionConditionTest, {
      asx_expected: expected,
      asx_order: order,
      [`${BIND_NAV.actionConditionTestGroup}@odata.bind`]: `/${ENTITY_SET.actionConditionGroup}(${groupId})`,
      [`${BIND_NAV.actionConditionTestOutcome}@odata.bind`]: `/${ENTITY_SET.group}(${outcome.id})`,
    });
    created.push({ set: ENTITY_SET.actionConditionTest, id });
  }

  // Creates `node`'s children under the already-created group `groupId`, recursively.
  async function createFiresWhenChildren(actionId: string, groupId: string, children: (WhenTest | WhenCfg)[]): Promise<void> {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if ("outcome" in child) {
        await createFiresWhenTest(groupId, child.outcome, child.is, i + 1);
      } else {
        const childId = await createFiresWhenGroup(actionId, whenOp(child), i + 1, groupId);
        await createFiresWhenChildren(actionId, childId, whenChildren(child));
      }
    }
  }

  function whenOp(node: WhenCfg): number {
    if (node.all && node.any) throw new Error("authorRule: a Fires-when node is either `all` or `any`, not both.");
    return node.any ? 2 : 1;
  }
  function whenChildren(node: WhenCfg): (WhenTest | WhenCfg)[] {
    return node.all ?? node.any ?? [];
  }

  // The action's tree: `when`, else the fireOn shorthand (the migration's mapping), else Always.
  async function createFiresWhenTree(actionId: string, a: ActionCfg, actionIndex: number): Promise<void> {
    let root: WhenCfg;
    if (a.when) {
      root = a.when;
    } else if (a.fireOn === 1) {
      root = { all: outcomes.map(o => ({ outcome: o.name, is: true })) };
    } else if (a.fireOn === 2) {
      if (!outcomes.length)
        throw new Error(`authorRule: action ${actionIndex + 1} has fireOn 2 (On no match) but the rule has no outcomes, so its tree would never fire. Give it outcomes or an explicit \`when\`.`);
      root = { any: outcomes.map(o => ({ outcome: o.name, is: false })) };
    } else if (a.fireOn !== undefined) {
      throw new Error(`authorRule: action ${actionIndex + 1} has fireOn ${a.fireOn}; only 1 (On match) or 2 (On no match) are translated. Omit fireOn for Always, or give a when tree.`);
    } else {
      root = { all: [] }; // Always
    }
    const rootId = await createFiresWhenGroup(actionId, whenOp(root), 1);
    await createFiresWhenChildren(actionId, rootId, whenChildren(root));
  }

  try {
    ruleId = await api.createRecord(ENTITY_SET.rule, {
      asx_name: ruleName,
      asx_tablelogicalname: cfg.tableLogicalName ?? "sample_order",
      // No statuscode here: the rule is born Draft, exactly like the editor's createRule
      // (client/src/editor/save/operations.ts). Published happens later via publishRule below.
      asx_triggers: cfg.triggers ?? "1,2,4",
      // Multi-select choice: Web API wants a comma-separated string of the int values. Empty ⇒ omit ⇒ all channels.
      ...(cfg.channels && cfg.channels.length ? { asx_channels: cfg.channels.join(",") } : {}),
      ...(cfg.evaluationContext ? { asx_evaluationcontext: cfg.evaluationContext } : {}),
      ...(cfg.evaluationTimeZone ? { asx_evaluationtimezone: cfg.evaluationTimeZone } : {}),
      ...(cfg.onDemandScope ? { asx_ondemandscope: cfg.onDemandScope } : {}),
      [`${BIND_NAV.ruleRootTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${cfg.rootNodeId})`,
    });
    created.push({ set: ENTITY_SET.rule, id: ruleId });

    // Outcomes: one validation group per cfg.outcomes entry, named exactly `name`; without
    // `outcomes`, the single group `${ruleName}_g` (unique per rule) holding cfg.conditions.
    if (cfg.outcomes) {
      for (const o of cfg.outcomes) {
        const id = await createValidationGroup(o.name, o.groupOp ?? 1);
        await addConditions(id, o.conditions, `${o.name}_c`);
        outcomes.push({ name: o.name, id });
      }
    } else {
      const id = await createValidationGroup(`${ruleName}_g`, cfg.groupOp ?? 1);
      await addConditions(id, cfg.conditions, `${ruleName}_c`);
      outcomes.push({ name: `${ruleName}_g`, id });
    }

    // Optional execution-condition gate group (asx_isexecutioncondition=true), evaluated before
    // the validation group above: a record that doesn't pass it never reaches match/no-match.
    if (cfg.executionConditions && cfg.executionConditions.length) {
      const execGroupId = await api.createRecord(ENTITY_SET.group, {
        asx_name: `${ruleName}_eg`,
        asx_logicaloperator: 1, // And
        asx_isexecutioncondition: true,
        [`${BIND_NAV.groupRule}@odata.bind`]: `/${ENTITY_SET.rule}(${ruleId})`,
      });
      created.push({ set: ENTITY_SET.group, id: execGroupId });
      await addConditions(execGroupId, cfg.executionConditions, `${ruleName}_ec`);
    }

    for (let i = 0; i < cfg.actions.length; i++) {
      const a = cfg.actions[i];
      const data: Record<string, unknown> = {
        asx_name: `${ruleName}_a${i + 1}`,
        asx_actiontype: a.actionType,
        asx_order: a.order ?? 1,
        asx_isactive: true,
        ...(a.targetColumn ? { asx_targetcolumn: a.targetColumn } : {}),
        ...(a.valueBool !== undefined ? { asx_valuebool: a.valueBool } : {}),
        ...(a.message !== undefined ? { asx_message: a.message } : {}),
        ...(a.severity ? { asx_severity: a.severity } : {}),
        ...(a.targetTable ? { asx_targettable: a.targetTable } : {}),
        ...(a.fieldMapping !== undefined ? { asx_fieldmapping: a.fieldMapping } : {}),
        ...(a.applyToPrevious !== undefined ? { asx_applytoprevious: a.applyToPrevious } : {}),
        ...(a.targetNodeId
          ? { [`${BIND_NAV.actionTargetNode}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${a.targetNodeId})` }
          : {}),
        [`${BIND_NAV.actionRule}@odata.bind`]: `/${ENTITY_SET.rule}(${ruleId})`,
      };
      const actionId = await api.createRecord(ENTITY_SET.action, data);
      created.push({ set: ENTITY_SET.action, id: actionId });
      await createFiresWhenTree(actionId, a, i);

      if (a.rowFilter) {
        if (!a.targetNodeId)
          throw new Error(`authorRule: action ${i + 1} has a rowFilter but no targetNodeId to filter — a Rows filter needs the action's own target node.`);
        const fgId = await api.createRecord(ENTITY_SET.nodeFilterGroup, {
          asx_logicaloperator: 1, // And
          [`${BIND_NAV.filterGroupAction}@odata.bind`]: `/${ENTITY_SET.action}(${actionId})`,
          [`${BIND_NAV.filterGroupTargetNode}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${a.targetNodeId})`,
        });
        created.push({ set: ENTITY_SET.nodeFilterGroup, id: fgId });
        await createFilterCriteria(api, fgId, a.rowFilter.criteria, created);
      }
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
      if (cfg.settleProbe) await awaitEnforcement(cfg.settleProbe, { label: ruleName, consecutive: cfg.settleConsecutive });
    }

    return { ruleId, ruleName, cleanup: () => deleteInReverse(created) };
  } catch (err) {
    await deleteInReverse(created).catch(cleanupError => console.warn("Fixture cleanup failed:", cleanupError));
    throw err;
  }
}
