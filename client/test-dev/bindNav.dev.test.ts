import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createDevApi, deleteDevRecord } from "./devApi";
import { BIND_NAV, ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { readDevEnv } from "./devEnv";

// Round-trips every @odata.bind nav prop in BIND_NAV against live DEV: create a
// child record binding the nav prop to a parent, read back the lookup's
// `_..._value` column, and assert it resolved to the parent id. A wrong
// nav-prop CASING either 400s on create (bind rejected) or leaves the lookup
// null on read: that failure IS the bug this catches (cf. ebf18bf). Every
// created record (including intermediate parents) self-cleans under the
// ZZ_P2RUN_ prefix.

const api = createDevApi();
const { runPrefix } = readDevEnv();
const created: { set: string; id: string }[] = [];

async function seededId(entitySet: string, name: string): Promise<string> {
  const r = await api.retrieveMultipleRecords(entitySet, `?$filter=asx_name eq '${name}'`);
  if (!r.entities.length) throw new Error(`seed ${name} missing in ${entitySet}; run seed-dev-fixtures.mjs`);
  const rec = r.entities[0];
  const idKey = Object.keys(rec).find((k) => k.endsWith("id") && !k.startsWith("_"))!;
  return rec[idKey];
}

let ruleId: string, rootCfg: string, groupId: string;

beforeAll(async () => {
  ruleId = await seededId(ENTITY_SET.rule, "ZZ_P2SEED_Rule");
  rootCfg = await seededId(ENTITY_SET.tableConfig, "ZZ_P2SEED_RootConfig");
  groupId = await seededId(ENTITY_SET.group, "ZZ_P2SEED_Group");
});

afterEach(async () => {
  while (created.length) {
    const c = created.pop()!;
    await deleteDevRecord(c.set, c.id);
  }
});

// Create a child in `set` binding `navProp` to `parentSet(parentId)`, then read
// back `lookupValueField` and assert it resolved to the parent id.
async function roundTrip(opts: {
  label: string;
  set: string;
  navProp: string;
  parentSet: string;
  parentId: string;
  lookupValueField: string;
  extra?: Record<string, any>;
}): Promise<string> {
  const id = await api.createRecord(opts.set, {
    asx_name: `${runPrefix}${opts.label}`,
    [`${opts.navProp}@odata.bind`]: `/${opts.parentSet}(${opts.parentId})`,
    ...opts.extra,
  });
  created.push({ set: opts.set, id });
  const rec = await api.retrieveRecord(opts.set, id, `?$select=${opts.lookupValueField}`);
  expect(String(rec[opts.lookupValueField]).toLowerCase()).toBe(opts.parentId.toLowerCase());
  return id;
}

// --- Intermediate-parent helpers (self-clean via `created`, same as roundTrip) ---

async function makeCondition(label: string): Promise<string> {
  const id = await api.createRecord(ENTITY_SET.condition, {
    asx_name: `${runPrefix}${label}`,
    "asx_conditiongroup@odata.bind": `/${ENTITY_SET.group}(${groupId})`,
    "asx_tableconfig@odata.bind": `/${ENTITY_SET.tableConfig}(${rootCfg})`,
    asx_conditiontype: 1,
  });
  created.push({ set: ENTITY_SET.condition, id });
  return id;
}

async function makeAction(label: string): Promise<string> {
  const id = await api.createRecord(ENTITY_SET.action, {
    asx_name: `${runPrefix}${label}`,
    "asx_rule@odata.bind": `/${ENTITY_SET.rule}(${ruleId})`,
    asx_actiontype: 4,
    asx_fireon: 1,
  });
  created.push({ set: ENTITY_SET.action, id });
  return id;
}

async function makeFilterGroup(label: string): Promise<string> {
  const id = await api.createRecord(ENTITY_SET.nodeFilterGroup, {
    asx_name: `${runPrefix}${label}`,
    "asx_conditiongroup@odata.bind": `/${ENTITY_SET.group}(${groupId})`,
    asx_logicaloperator: 1,
  });
  created.push({ set: ENTITY_SET.nodeFilterGroup, id });
  return id;
}

async function makeFilterCriterion(label: string, filterGroupId: string): Promise<string> {
  const id = await api.createRecord(ENTITY_SET.nodeFilterCriterion, {
    asx_name: `${runPrefix}${label}`,
    "asx_filtergroup@odata.bind": `/${ENTITY_SET.nodeFilterGroup}(${filterGroupId})`,
    asx_fieldname: "name",
    asx_operator: "eq",
  });
  created.push({ set: ENTITY_SET.nodeFilterCriterion, id });
  return id;
}

describe("BIND_NAV @odata.bind round-trips against DEV", () => {
  it("groupRule binds a condition group to its rule", () =>
    roundTrip({
      label: "groupRule",
      set: ENTITY_SET.group, navProp: BIND_NAV.groupRule,
      parentSet: ENTITY_SET.rule, parentId: ruleId,
      lookupValueField: LOOKUP.ruleOfGroup, // "_asx_rule_value"
      extra: { asx_logicaloperator: 1, asx_isexecutioncondition: false },
    }));

  it("groupParent binds a condition group to its parent group", () =>
    roundTrip({
      label: "groupParent",
      set: ENTITY_SET.group, navProp: BIND_NAV.groupParent,
      parentSet: ENTITY_SET.group, parentId: groupId,
      lookupValueField: LOOKUP.parentGroup, // "_asx_parentconditiongroup_value"
      extra: {
        "asx_rule@odata.bind": `/${ENTITY_SET.rule}(${ruleId})`,
        asx_logicaloperator: 1, asx_isexecutioncondition: false,
      },
    }));

  it("conditionGroup binds a rule condition to its condition group", () =>
    roundTrip({
      label: "conditionGroup",
      set: ENTITY_SET.condition, navProp: BIND_NAV.conditionGroup,
      parentSet: ENTITY_SET.group, parentId: groupId,
      lookupValueField: "_asx_conditiongroup_value",
      extra: {
        "asx_tableconfig@odata.bind": `/${ENTITY_SET.tableConfig}(${rootCfg})`,
        asx_conditiontype: 1,
      },
    }));

  it("conditionTableConfig binds a rule condition to its evaluated node", () =>
    roundTrip({
      label: "conditionTableConfig",
      set: ENTITY_SET.condition, navProp: BIND_NAV.conditionTableConfig,
      parentSet: ENTITY_SET.tableConfig, parentId: rootCfg,
      lookupValueField: LOOKUP.conditionTableConfig, // "_asx_tableconfig_value"
      extra: {
        "asx_conditiongroup@odata.bind": `/${ENTITY_SET.group}(${groupId})`,
        asx_conditiontype: 1,
      },
    }));

  it("conditionValueNode binds a rule condition's FieldReference RHS node", () =>
    roundTrip({
      label: "conditionValueNode",
      set: ENTITY_SET.condition, navProp: BIND_NAV.conditionValueNode, // PascalCase: asx_ComparisonValueNode
      parentSet: ENTITY_SET.tableConfig, parentId: rootCfg,
      lookupValueField: LOOKUP.comparisonValueNode, // "_asx_comparisonvaluenode_value"
      extra: {
        "asx_conditiongroup@odata.bind": `/${ENTITY_SET.group}(${groupId})`,
        "asx_tableconfig@odata.bind": `/${ENTITY_SET.tableConfig}(${rootCfg})`,
        asx_conditiontype: 1,
      },
    }));

  it("actionRule binds a rule action to its rule", () =>
    roundTrip({
      label: "actionRule",
      set: ENTITY_SET.action, navProp: BIND_NAV.actionRule,
      parentSet: ENTITY_SET.rule, parentId: ruleId,
      lookupValueField: LOOKUP.ruleOfAction, // "_asx_rule_value"
      extra: { asx_actiontype: 4, asx_fireon: 1 },
    }));

  it("actionTargetNode binds a rule action's Update/Delete target node", () =>
    roundTrip({
      label: "actionTargetNode",
      set: ENTITY_SET.action, navProp: BIND_NAV.actionTargetNode, // PascalCase: asx_TargetNode
      parentSet: ENTITY_SET.tableConfig, parentId: rootCfg,
      lookupValueField: LOOKUP.actionTargetNode, // "_asx_targetnode_value"
      extra: {
        "asx_rule@odata.bind": `/${ENTITY_SET.rule}(${ruleId})`,
        asx_actiontype: 4, asx_fireon: 1,
      },
    }));

  it("localizedMessageAction binds a localized message to its parent action", async () => {
    const actionId = await makeAction("localizedMessageAction_action");
    await roundTrip({
      label: "localizedMessageAction",
      set: ENTITY_SET.localizedMessage, navProp: BIND_NAV.localizedMessageAction, // PascalCase: asx_RuleAction
      parentSet: ENTITY_SET.action, parentId: actionId,
      lookupValueField: "_asx_ruleaction_value",
      extra: { asx_languagecode: 1033, asx_message: "test" },
    });
  });

  it("tableConfigParent binds a table config node to its parent node", () =>
    roundTrip({
      label: "tableConfigParent",
      set: ENTITY_SET.tableConfig, navProp: BIND_NAV.tableConfigParent,
      parentSet: ENTITY_SET.tableConfig, parentId: rootCfg,
      lookupValueField: LOOKUP.parentTableOfConfig, // "_asx_parenttable_value"
      extra: { asx_tablelogicalname: "account", asx_tableconfigtype: 1 },
    }));

  it("ruleRootTableConfig binds a rule to its root config", () =>
    roundTrip({
      label: "ruleRootTableConfig",
      set: ENTITY_SET.rule, navProp: BIND_NAV.ruleRootTableConfig, // PascalCase: asx_RootTableConfig
      parentSet: ENTITY_SET.tableConfig, parentId: rootCfg,
      lookupValueField: LOOKUP.ruleOfTableConfig, // "_asx_roottableconfig_value"
      extra: { asx_tablelogicalname: "account" },
    }));

  it("filterGroupCondition binds a node filter group to its owning rule condition", async () => {
    const condId = await makeCondition("filterGroupCondition_condition");
    await roundTrip({
      label: "filterGroupCondition",
      set: ENTITY_SET.nodeFilterGroup, navProp: BIND_NAV.filterGroupCondition, // PascalCase: asx_RuleCondition
      parentSet: ENTITY_SET.condition, parentId: condId,
      lookupValueField: LOOKUP.filterGroupCondition, // "_asx_rulecondition_value"
      extra: {
        "asx_conditiongroup@odata.bind": `/${ENTITY_SET.group}(${groupId})`,
        asx_logicaloperator: 1,
      },
    });
  });

  it("filterGroupConditionGroup binds a node filter group to its scoping condition group", () =>
    roundTrip({
      label: "filterGroupConditionGroup",
      set: ENTITY_SET.nodeFilterGroup, navProp: BIND_NAV.filterGroupConditionGroup,
      parentSet: ENTITY_SET.group, parentId: groupId,
      lookupValueField: "_asx_conditiongroup_value",
      extra: { asx_logicaloperator: 1 },
    }));

  it("filterGroupTargetNode binds a node filter group to its targeted node", () =>
    roundTrip({
      label: "filterGroupTargetNode",
      set: ENTITY_SET.nodeFilterGroup, navProp: BIND_NAV.filterGroupTargetNode,
      parentSet: ENTITY_SET.tableConfig, parentId: rootCfg,
      lookupValueField: LOOKUP.filterGroupTargetNode, // "_asx_tableconfignode_value"
      extra: {
        "asx_conditiongroup@odata.bind": `/${ENTITY_SET.group}(${groupId})`,
        asx_logicaloperator: 1,
      },
    }));

  it("filterGroupParent binds a node filter group to its parent filter group", async () => {
    const parentFilterGroup = await makeFilterGroup("filterGroupParent_parent");
    await roundTrip({
      label: "filterGroupParent",
      set: ENTITY_SET.nodeFilterGroup, navProp: BIND_NAV.filterGroupParent,
      parentSet: ENTITY_SET.nodeFilterGroup, parentId: parentFilterGroup,
      lookupValueField: LOOKUP.filterParentGroup, // "_asx_parentfiltergroup_value"
      extra: {
        "asx_conditiongroup@odata.bind": `/${ENTITY_SET.group}(${groupId})`,
        asx_logicaloperator: 1,
      },
    });
  });

  it("filterCriterionGroup binds a node filter criterion to its parent filter group", async () => {
    const filterGroup = await makeFilterGroup("filterCriterionGroup_group");
    await roundTrip({
      label: "filterCriterionGroup",
      set: ENTITY_SET.nodeFilterCriterion, navProp: BIND_NAV.filterCriterionGroup,
      parentSet: ENTITY_SET.nodeFilterGroup, parentId: filterGroup,
      lookupValueField: LOOKUP.filterGroupOfCriterion, // "_asx_filtergroup_value"
      extra: { asx_fieldname: "name", asx_operator: "eq" },
    });
  });

  it("filterCriterionValueNode binds a node filter criterion's FieldReference RHS node", async () => {
    const filterGroup = await makeFilterGroup("filterCriterionValueNode_group");
    await roundTrip({
      label: "filterCriterionValueNode",
      set: ENTITY_SET.nodeFilterCriterion, navProp: BIND_NAV.filterCriterionValueNode, // PascalCase: asx_ComparisonValueNode
      parentSet: ENTITY_SET.tableConfig, parentId: rootCfg,
      lookupValueField: LOOKUP.filterCriterionValueNode, // "_asx_comparisonvaluenode_value"
      extra: {
        "asx_filtergroup@odata.bind": `/${ENTITY_SET.nodeFilterGroup}(${filterGroup})`,
        asx_fieldname: "name", asx_operator: "eq",
      },
    });
  });

  it("filterCriterionCollectionNode binds an Exists criterion to its counted collection node", async () => {
    const filterGroup = await makeFilterGroup("filterCriterionCollectionNode_group");
    await roundTrip({
      label: "filterCriterionCollectionNode",
      set: ENTITY_SET.nodeFilterCriterion, navProp: BIND_NAV.filterCriterionCollectionNode,
      parentSet: ENTITY_SET.tableConfig, parentId: rootCfg,
      lookupValueField: LOOKUP.filterCriterionCollectionNode, // "_asx_collectionnode_value"
      extra: {
        "asx_filtergroup@odata.bind": `/${ENTITY_SET.nodeFilterGroup}(${filterGroup})`,
        asx_fieldname: "name", asx_operator: "eq",
      },
    });
  });

  it("filterGroupOwningCriterion binds an Exists sub-filter group to its owning criterion", async () => {
    const filterGroup = await makeFilterGroup("filterGroupOwningCriterion_group");
    const criterion = await makeFilterCriterion("filterGroupOwningCriterion_criterion", filterGroup);
    await roundTrip({
      label: "filterGroupOwningCriterion",
      set: ENTITY_SET.nodeFilterGroup, navProp: BIND_NAV.filterGroupOwningCriterion,
      parentSet: ENTITY_SET.nodeFilterCriterion, parentId: criterion,
      lookupValueField: LOOKUP.filterGroupOwningCriterion, // "_asx_owningcriterion_value"
      extra: {
        "asx_conditiongroup@odata.bind": `/${ENTITY_SET.group}(${groupId})`,
        asx_logicaloperator: 1,
      },
    });
  });
});
