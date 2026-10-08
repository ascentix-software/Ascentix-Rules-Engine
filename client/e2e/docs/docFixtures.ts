// The documentation demo set on DEV: the "Orders" data model and six rules on sample_order that
// the guide's screenshots show. Persistent on purpose (retakes reuse it), and named WITHOUT the
// ZZ_ prefix so the test sweeps leave it alone. Every rule stays unpublished: Preview runs a
// never-published rule's draft, so nothing here ever fires on a save or a form during e2e/L2.
//
// ensureDocSet() is idempotent: it finds each piece by name and creates only what's missing. To
// rebuild a piece, delete it on DEV (the hub's Delete) and run the capture again.

import { createDevApi, updateDevRecord } from "../../test-dev/devApi";
import { authorRule, type ConditionCfg, type RuleConfig } from "../../test-dev/ruleBehavior/authoring";
import { ENTITY_SET, BIND_NAV, LOOKUP } from "../../src/editor/load/odata";

export const DOC_MODEL = "Orders";
export const DOC_RULES = {
  credit: "Order total within credit limit",
  lines: "Order needs at least one line",
  email: "Order contact email must be valid",
  expedited: "Expedited order review",
  stamp: "Stamp review note on expedited orders",
  broken: "Draft: order contact tier check (needs work)",
} as const;
// Typed into the hub search so the list shows only the demo rules (every name contains it).
export const DOC_HUB_FILTER = "Order";

export interface DocModel { rootId: string; customerId: string; linesId: string; productId: string }

async function findOne(set: string, filter: string, select: string): Promise<any | null> {
  const r = await createDevApi().retrieveMultipleRecords(set, `?$select=${select}&$filter=${filter}&$top=1`);
  return r.entities[0] ?? null;
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function ensureNode(parentId: string | null, data: Record<string, unknown>): Promise<string> {
  const api = createDevApi();
  const parentFilter = parentId ? `${LOOKUP.parentTableOfConfig} eq ${parentId}` : `${LOOKUP.parentTableOfConfig} eq null`;
  const found = await findOne(ENTITY_SET.tableConfig,
    `asx_name eq ${q(String(data.asx_name))} and ${parentFilter}`, "asx_tableconfigid");
  if (found) return found.asx_tableconfigid;
  return api.createRecord(ENTITY_SET.tableConfig, {
    ...data,
    ...(parentId ? { [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${parentId})` } : {}),
  });
}

/** Orders: Order (root) → Customer (looks up) and Order lines (has many) → Product (looks up). */
export async function ensureDocModel(): Promise<DocModel> {
  const rootId = await ensureNode(null, { asx_name: DOC_MODEL, asx_tablelogicalname: "sample_order", asx_tableconfigtype: 1 });
  const customerId = await ensureNode(rootId, {
    asx_name: "Customer", asx_tablelogicalname: "sample_customer", asx_tableconfigtype: 2,
    asx_lookupcolumnlogicalname: "sample_customerid", asx_lookuptargetidattribute: "sample_customerid",
  });
  const linesId = await ensureNode(rootId, {
    asx_name: "Order lines", asx_tablelogicalname: "sample_orderline", asx_tableconfigtype: 3,
    asx_childlinkfield: "sample_orderid",
  });
  const productId = await ensureNode(linesId, {
    asx_name: "Product", asx_tablelogicalname: "sample_product", asx_tableconfigtype: 2,
    asx_lookupcolumnlogicalname: "sample_productid", asx_lookuptargetidattribute: "sample_productid",
  });
  return { rootId, customerId, linesId, productId };
}

// authorRule names everything for its test sweep (ZZ_RB_ rule, "<rule>_c1" conditions). Give the
// rule its real name and blank the condition and action names so the editor derives them.
export const DOC_ONLY_IF_GROUP = "Has a customer";

async function tidy(ruleId: string, name: string): Promise<void> {
  const api = createDevApi();
  await updateDevRecord(ENTITY_SET.rule, ruleId, { asx_name: name });
  const groups = await api.retrieveMultipleRecords(ENTITY_SET.group,
    `?$select=asx_conditiongroupid,asx_isexecutioncondition&$filter=${LOOKUP.ruleOfGroup} eq ${ruleId}`);
  for (const g of groups.entities) {
    // The Only if group (the demo set has one, on the credit rule).
    if (g.asx_isexecutioncondition) await updateDevRecord(ENTITY_SET.group, g.asx_conditiongroupid, { asx_name: DOC_ONLY_IF_GROUP });
    const conds = await api.retrieveMultipleRecords(ENTITY_SET.condition,
      `?$select=asx_ruleconditionid&$filter=_asx_conditiongroup_value eq ${g.asx_conditiongroupid}`);
    for (const c of conds.entities) await updateDevRecord(ENTITY_SET.condition, c.asx_ruleconditionid, { asx_name: null });
  }
  const actions = await api.retrieveMultipleRecords(ENTITY_SET.action,
    `?$select=asx_ruleactionid&$filter=${LOOKUP.ruleOfAction} eq ${ruleId}`);
  for (const a of actions.entities) await updateDevRecord(ENTITY_SET.action, a.asx_ruleactionid, { asx_name: null });
}

async function ensureRule(name: string, cfg: Omit<RuleConfig, "name">, after?: (ruleId: string) => Promise<void>): Promise<string> {
  const found = await findOne(ENTITY_SET.rule, `asx_name eq ${q(name)} and _asx_draftof_value eq null`, "asx_ruleid");
  if (found) return found.asx_ruleid;
  const rule = await authorRule({ ...cfg, name: `doc_${Date.now()}`, publish: false, requireValid: false });
  await tidy(rule.ruleId, name);
  if (after) await after(rule.ruleId);
  return rule.ruleId;
}

/** A nested subgroup under an outcome: what the building-conditions screenshot shows. */
async function addSubgroup(ruleId: string, outcome: string, name: string, op: 1 | 2, conditions: ConditionCfg[]): Promise<void> {
  const api = createDevApi();
  const parent = await findOne(ENTITY_SET.group, `${LOOKUP.ruleOfGroup} eq ${ruleId} and asx_name eq ${q(outcome)}`, "asx_conditiongroupid");
  if (!parent) throw new Error(`Outcome ${outcome} not found on ${ruleId}`);
  const groupId = await api.createRecord(ENTITY_SET.group, {
    asx_name: name, asx_logicaloperator: op, asx_isexecutioncondition: false,
    [`${BIND_NAV.groupRule}@odata.bind`]: `/${ENTITY_SET.rule}(${ruleId})`,
    [`${BIND_NAV.groupParent}@odata.bind`]: `/${ENTITY_SET.group}(${parent.asx_conditiongroupid})`,
  });
  for (const c of conditions) {
    await api.createRecord(ENTITY_SET.condition, {
      asx_conditiontype: c.conditionType, asx_comparisoncolumn: c.column, asx_comparisonoperator: c.operator,
      asx_comparisonvaluesource: c.valueSource ?? 1, asx_comparisonvalue: c.literal,
      [`${BIND_NAV.conditionGroup}@odata.bind`]: `/${ENTITY_SET.group}(${groupId})`,
      [`${BIND_NAV.conditionTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${c.nodeId})`,
    });
  }
}

export async function ensureDocSet(): Promise<{ model: DocModel; rules: Record<keyof typeof DOC_RULES, string> }> {
  const m = await ensureDocModel();
  const credit = await ensureRule(DOC_RULES.credit, {
    rootNodeId: m.rootId, triggers: "1,2,4",
    executionConditions: [{ nodeId: m.rootId, conditionType: 1, column: "sample_customerid", operator: 10, valueSource: 1 }],
    outcomes: [{ name: "Credit check", groupOp: 2, conditions: [
      { nodeId: m.rootId, conditionType: 1, column: "sample_ordertotal", operator: 6, valueSource: 2,
        valueColumn: "sample_creditlimit", valueNodeId: m.customerId },
    ] }],
    conditions: [],
    actions: [{ actionType: 4, when: { all: [{ outcome: "Credit check", is: false }] },
      message: "Order total exceeds the customer's credit limit.", severity: 3 }],
  }, (id) => addSubgroup(id, "Credit check", "Small order", 1, [
    { nodeId: m.rootId, conditionType: 1, column: "sample_ordertotal", operator: 5, valueSource: 1, literal: "500" },
    { nodeId: m.rootId, conditionType: 1, column: "sample_isexpedited", operator: 1, valueSource: 1, literal: "false" },
  ]));
  const lines = await ensureRule(DOC_RULES.lines, {
    rootNodeId: m.rootId, triggers: "1,4",
    outcomes: [{ name: "Has a large line", conditions: [
      { nodeId: m.linesId, conditionType: 2, minRows: 1,
        nodeFilter: { targetNodeId: m.linesId, criteria: [{ fieldName: "sample_lineamount", operator: "gt", value: "100" }] } },
    ] }],
    conditions: [],
    actions: [{ actionType: 4, when: { all: [{ outcome: "Has a large line", is: false }] },
      message: "Add at least one order line over 100.", severity: 3 }],
  });
  const email = await ensureRule(DOC_RULES.email, {
    rootNodeId: m.rootId, triggers: "1,2,4",
    outcomes: [{ name: "Valid email", conditions: [
      { nodeId: m.rootId, conditionType: 3, column: "sample_contactemail", literal: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
    ] }],
    conditions: [],
    actions: [{ actionType: 3, when: { all: [{ outcome: "Valid email", is: false }] },
      targetColumn: "sample_contactemail", message: "Enter a valid email address.", severity: 2 }],
  });
  const expedited = await ensureRule(DOC_RULES.expedited, {
    rootNodeId: m.rootId, triggers: "2,4",
    outcomes: [
      { name: "Expedited", conditions: [{ nodeId: m.rootId, conditionType: 1, column: "sample_isexpedited", operator: 1, valueSource: 1, literal: "true" }] },
      { name: "Large order value", conditions: [{ nodeId: m.rootId, conditionType: 4,
        expression: `sum(node:${m.linesId}.sample_lineamount) + {root.sample_ordertotal}`, operator: 3, literal: "5000" }] },
    ],
    conditions: [],
    actions: [
      { actionType: 2, when: { all: [{ outcome: "Expedited", is: true }] }, targetColumn: "sample_handlinginstructions", valueBool: true, order: 1 },
      { actionType: 3, when: { all: [{ outcome: "Expedited", is: true }, { outcome: "Large order value", is: true }] },
        message: "Large expedited orders need a manager's approval before they ship.", severity: 1, order: 2 },
    ],
  });
  const stamp = await ensureRule(DOC_RULES.stamp, {
    rootNodeId: m.rootId, triggers: "1,4",
    outcomes: [{ name: "Expedited", conditions: [{ nodeId: m.rootId, conditionType: 1, column: "sample_isexpedited", operator: 1, valueSource: 1, literal: "true" }] }],
    conditions: [],
    actions: [{ actionType: 6, when: { all: [{ outcome: "Expedited", is: true }] }, targetNodeId: m.rootId,
      fieldMapping: JSON.stringify([
        { target: "sample_approvalnotes", source: "template", template: "Expedited {root.sample_name}: review before shipping." },
        { target: "sample_handlinginstructions", source: "literal", value: "Ship within 24 hours." },
      ]) }],
  });
  const broken = await ensureRule(DOC_RULES.broken, {
    rootNodeId: m.rootId, triggers: "2,4",
    outcomes: [{ name: "Gold tier", conditions: [{ nodeId: m.customerId, conditionType: 1, column: "sample_tier", operator: 1, valueSource: 1, literal: "Gold" }] }],
    conditions: [],
    actions: [{ actionType: 3, when: { all: [{ outcome: "Gold tier", is: true }] }, targetColumn: "sample_tierlabel",
      message: "Gold customer: offer priority shipping.", severity: 1 }],
  });
  return { model: m, rules: { credit, lines, email, expedited, stamp, broken } };
}
