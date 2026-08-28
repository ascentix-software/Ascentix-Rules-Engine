import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { readDevEnv } from "../test-dev/devEnv";
import { ENTITY_SET, BIND_NAV, LOOKUP } from "../src/editor/load/odata";

// Find a record's id by exact name match; null when absent. For locating rows the UI
// created (New-rule dialog, "Copy of X" duplicates) that no fixture tracked.
export async function findIdByName(entitySet: string, nameField: string, idField: string, name: string): Promise<string | null> {
  const api = createDevApi();
  const safe = name.replace(/'/g, "''");
  const r = await api.retrieveMultipleRecords(entitySet, `?$filter=${nameField} eq '${safe}'&$select=${idField}`);
  return r.entities.length ? (r.entities[0][idField] as string) : null;
}

// Deletes a rule and ALL its children, including rows the UI created that no fixture
// tracked (author-in-UI, write-action, duplicate specs). Child-first: conditions →
// subgroups → root groups → actions → rule. Node-filter rows are not queried: the e2e
// fixtures never author them through the UI.
export async function deleteRuleCascade(ruleId: string): Promise<void> {
  const api = createDevApi();
  const list = async (set: string, filter: string, idField: string) =>
    (await api.retrieveMultipleRecords(set, `?$filter=${filter}&$select=${idField}`)).entities.map(
      (e) => e[idField] as string,
    );
  const groups = (await api.retrieveMultipleRecords(
    ENTITY_SET.group,
    `?$filter=${LOOKUP.ruleOfGroup} eq ${ruleId}&$select=asx_conditiongroupid,${LOOKUP.parentGroup}`,
  )).entities;
  for (const g of groups) {
    for (const cid of await list(ENTITY_SET.condition, `_asx_conditiongroup_value eq ${g.asx_conditiongroupid}`, "asx_ruleconditionid")) {
      // Node-filter rows hang off the CONDITION and do NOT cascade when it is deleted (the same
      // note diff.ts carries at its filter-delete branch). Since nodeFilterUi.e2e authors them
      // through the UI, this cascade has to reclaim them or every run leaks a filter tree.
      // Criteria first, then the groups deepest-first (a child group binds its parent).
      const fgroups = (await api.retrieveMultipleRecords(
        ENTITY_SET.nodeFilterGroup,
        `?$filter=${LOOKUP.filterGroupCondition} eq ${cid}&$select=asx_nodefiltergroupid,${LOOKUP.filterParentGroup}`,
      )).entities;
      for (const fg of fgroups) {
        for (const crit of await list(
          ENTITY_SET.nodeFilterCriterion,
          `${LOOKUP.filterGroupOfCriterion} eq ${fg.asx_nodefiltergroupid}`,
          "asx_nodefiltercriterionid",
        )) {
          await deleteDevRecord(ENTITY_SET.nodeFilterCriterion, crit).catch(() => {});
        }
      }
      const childFirst = [...fgroups].sort((a, b) =>
        (a[LOOKUP.filterParentGroup] ? 0 : 1) - (b[LOOKUP.filterParentGroup] ? 0 : 1));
      for (const fg of childFirst) {
        await deleteDevRecord(ENTITY_SET.nodeFilterGroup, fg.asx_nodefiltergroupid as string).catch(() => {});
      }
      await deleteDevRecord(ENTITY_SET.condition, cid).catch(() => {});
    }
  }
  const subFirst = [...groups].sort((a, b) =>
    (a[LOOKUP.parentGroup] ? 0 : 1) - (b[LOOKUP.parentGroup] ? 0 : 1));
  for (const g of subFirst) await deleteDevRecord(ENTITY_SET.group, g.asx_conditiongroupid as string).catch(() => {});
  for (const aid of await list(ENTITY_SET.action, `${LOOKUP.ruleOfAction} eq ${ruleId}`, "asx_ruleactionid")) {
    // Localized-message children first: the UI can author them (ActionInspector's Translations
    // field), and asx_localizedmessage rows do not cascade off the action delete.
    for (const mid of await list(
      ENTITY_SET.localizedMessage, `_asx_ruleaction_value eq ${aid}`, "asx_localizedmessageid",
    )) {
      await deleteDevRecord(ENTITY_SET.localizedMessage, mid).catch(() => {});
    }
    await deleteDevRecord(ENTITY_SET.action, aid).catch(() => {});
  }
  await deleteDevRecord(ENTITY_SET.rule, ruleId).catch(() => {});
}

// Single root-table config node under the ZZ_RB_ prefix (sweep backstop). cleanup()
// deletes any child nodes the UI added (leaf-first) before the root.
export async function createZzRootConfig(name: string, table: string): Promise<{ id: string; cleanup: () => Promise<void> }> {
  const api = createDevApi();
  const cfgName = name.startsWith("ZZ_RB_") ? name : `ZZ_RB_${name}`;
  const id = await api.createRecord(ENTITY_SET.tableConfig, {
    asx_name: cfgName, asx_tablelogicalname: table, asx_tableconfigtype: 1,
  });
  const cleanup = async () => {
    // Depth-first: collect descendants, delete deepest-first.
    const all: string[] = [];
    const walk = async (parentId: string) => {
      const r = await api.retrieveMultipleRecords(
        ENTITY_SET.tableConfig,
        `?$filter=${LOOKUP.parentTableOfConfig} eq ${parentId}&$select=asx_tableconfigid`,
      );
      for (const e of r.entities) {
        const childId = e.asx_tableconfigid as string;
        await walk(childId);
        all.push(childId);
      }
    };
    await walk(id);
    for (const nodeId of all) await deleteDevRecord(ENTITY_SET.tableConfig, nodeId).catch(() => {});
    await deleteDevRecord(ENTITY_SET.tableConfig, id).catch(() => {});
  };
  return { id, cleanup };
}

export async function resolveAppId(): Promise<string> {
  const api = createDevApi();
  const r = await api.retrieveMultipleRecords(
    "appmodules",
    "?$filter=uniquename eq 'asx_AscentixDataverseRulesEngine'&$select=appmoduleid",
  );
  if (!r.entities.length) throw new Error("App 'asx_AscentixDataverseRulesEngine' not found in DEV.");
  return r.entities[0].appmoduleid as string;
}

// The app-frame hub URL. NOTE: a `&data=<ruleId>` deep-link does NOT open the rule
// editor: resolveRoute (src/editor/ui/router.ts) only returns the "rule" view when the
// URL carries `?view=rule` or `?typename=asx_rule`; `data` alone sets the id but falls
// through to the hub. So we open the hub and click the rule's row, which the hub's own
// navigate("rule", id) turns into `?view=rule&id=…` (a real reload into the rule editor).
export function hubDeepLink(appId: string): string {
  const { dataverseUrl } = readDevEnv();
  const wr = encodeURIComponent("asx_/ruleeditor/asx_ruleeditor.html");
  return `${dataverseUrl.replace(/\/+$/, "")}/main.aspx?appid=${appId}` +
    `&pagetype=webresource&webresourceName=${wr}`;
}

export interface RuleFixtureOpts {
  namePrefix?: string; // default ZZ_P2E2E_e2e
  withGroup?: boolean; // default true
  withCondition?: boolean | "incomplete"; // default true; "incomplete" = column only (invalid)
  withAction?: boolean; // default true
  validate?: boolean; // default true; fail fast if the rule isn't publishable
}

// Creates a Draft rule on `account` (root config + optional exec group / comparison
// condition / ShowMessage action), trigger Manual only, ZZ-prefixed. Options carve out
// the variants the e2e specs need: a bare rule to author against in the UI, an
// incomplete condition for the validation-failure path, or the default fully-valid
// shape. Returns a cleanup that deletes everything it created (reverse order).
export async function createRuleFixture(opts: RuleFixtureOpts = {}): Promise<{ ruleId: string; ruleName: string; cleanup: () => Promise<void> }> {
  const api = createDevApi();
  // Unique per call: identical names across tests turn one leaked fixture (e.g. a test
  // timeout abandoning its finally) into strict-mode violations for every later test.
  // ZZ_RB_ prefix so sweepRuleBehaviorOrphans reclaims leaks.
  const stamp = `${opts.namePrefix ?? "ZZ_RB_p2e2e"}_${Math.random().toString(36).slice(2, 8)}`;
  const ruleName = `${stamp}_rule`;
  const created: { set: string; id: string }[] = [];
  const track = (set: string, id: string) => { created.push({ set, id }); return id; };
  const cleanup = async () => {
    for (const c of created.reverse()) {
      await deleteDevRecord(c.set, c.id).catch(
        (e) => console.warn(`ZZ_P2E2E_ cleanup: failed to delete ${c.set}(${c.id}): ${e}`),
      );
    }
  };

  try {
    // createDevApi() is a raw REST client (unlike xrm.WebApi in the browser, which resolves a
    // singular logical name to its entity set itself): its createRecord needs the entity SET
    // name (plural) directly in the URL, confirmed by P2a's own bindNav.dev.test.ts. Passing
    // ENTITY.* (singular) here 404s: "Resource not found for the segment 'asx_tableconfig'".
    const cfgId = track(ENTITY_SET.tableConfig, await api.createRecord(ENTITY_SET.tableConfig, {
      asx_name: `${stamp}_cfg`, asx_tablelogicalname: "account", asx_tableconfigtype: 1,
    }));
    const ruleId = track(ENTITY_SET.rule, await api.createRecord(ENTITY_SET.rule, {
      asx_name: ruleName, asx_tablelogicalname: "account",
      asx_triggers: "3", // Manual only, never auto-fires
      [`${BIND_NAV.ruleRootTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${cfgId})`,
    }));
    if (opts.withGroup ?? true) {
      const groupId = track(ENTITY_SET.group, await api.createRecord(ENTITY_SET.group, {
        asx_name: `${stamp}_grp`, asx_logicaloperator: 1, asx_isexecutioncondition: true,
        [`${BIND_NAV.groupRule}@odata.bind`]: `/${ENTITY_SET.rule}(${ruleId})`,
      }));
      const withCondition = opts.withCondition ?? true;
      if (withCondition === "incomplete") {
        // Column only, no operator/value: structurally present but invalid, for the
        // validation-failure e2e path.
        track(ENTITY_SET.condition, await api.createRecord(ENTITY_SET.condition, {
          asx_name: `${stamp}_cond`, asx_conditiontype: 1,
          asx_comparisoncolumn: "revenue",
          [`${BIND_NAV.conditionGroup}@odata.bind`]: `/${ENTITY_SET.group}(${groupId})`,
          [`${BIND_NAV.conditionTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${cfgId})`,
        }));
      } else if (withCondition) {
        // One complete comparison condition: account.revenue >= 0 (always structurally valid).
        // asx_comparisonoperator is a numeric Choice (docs/Schema.md §2.4; Core/Models/Enums.cs
        // ComparisonOperator): GreaterThanOrEqual = 4, NOT the string "ge" (that token is only
        // used for node-filter-criterion operator tokens, a different field).
        track(ENTITY_SET.condition, await api.createRecord(ENTITY_SET.condition, {
          asx_name: `${stamp}_cond`, asx_conditiontype: 1,
          asx_comparisoncolumn: "revenue", asx_comparisonoperator: 4 /* GreaterThanOrEqual */,
          asx_comparisonvaluesource: 1, asx_comparisonvalue: "0",
          [`${BIND_NAV.conditionGroup}@odata.bind`]: `/${ENTITY_SET.group}(${groupId})`,
          [`${BIND_NAV.conditionTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${cfgId})`,
        }));
      }
    }
    if (opts.withAction ?? true) {
      // One complete ShowMessage action (writes no data).
      track(ENTITY_SET.action, await api.createRecord(ENTITY_SET.action, {
        asx_name: `${stamp}_act`, asx_actiontype: 3 /* ShowMessage */, asx_order: 1, asx_fireon: 1,
        asx_message: "E2E throwaway — safe to ignore.", asx_severity: 1,
        [`${BIND_NAV.actionRule}@odata.bind`]: `/${ENTITY_SET.rule}(${ruleId})`,
      }));
    }

    if (opts.validate ?? true) {
      // Fail fast if the rule isn't publishable: the browser flow needs Validate to pass.
      const verdict = await api.validateRule(ruleId);
      if (!verdict.isValid) throw new Error("Rule fixture did not validate: " + JSON.stringify(verdict.issues));
    }

    return { ruleId, ruleName, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

// The original P2 helper: a fully-valid Draft rule. Thin wrapper over createRuleFixture.
export async function createThrowawayRule(): Promise<{ ruleId: string; ruleName: string; cleanup: () => Promise<void> }> {
  return createRuleFixture();
}

// ---- e2e expansion helpers ---------------------------------------------------------------
// Shapes the newer editor-UI specs need that createRuleFixture (account, flat) can't express:
// a two-level config tree (so RowCount / node-filter / aggregate surfaces light up) and a rule
// bound to an already-built tree.

// Adds a ChildTable node under `parentId`. Returned id is tracked by the PARENT's cleanup
// (createZzRootConfig walks descendants depth-first), so callers need no extra bookkeeping.
export async function addChildNode(
  parentId: string,
  opts: { name: string; table: string; childLinkField: string },
): Promise<string> {
  const api = createDevApi();
  return api.createRecord(ENTITY_SET.tableConfig, {
    asx_name: opts.name.startsWith("ZZ_RB_") ? opts.name : `ZZ_RB_${opts.name}`,
    asx_tablelogicalname: opts.table,
    asx_tableconfigtype: 3 /* ChildTable */,
    asx_childlinkfield: opts.childLinkField,
    [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${parentId})`,
  });
}

// Root `sample_order` config + one `sample_orderline` child collection. The canonical shape for
// every surface that needs a many-cardinality node: RowCount conditions, "Only consider records
// where…", Insert-aggregate, UpdateRecord target nodes.
export async function createOrderConfigTree(
  name: string,
): Promise<{ rootId: string; childId: string; cleanup: () => Promise<void> }> {
  const root = await createZzRootConfig(name, "sample_order");
  try {
    const childId = await addChildNode(root.id, {
      name: `${name}_line`, table: "sample_orderline", childLinkField: "sample_orderid",
    });
    return { rootId: root.id, childId, cleanup: root.cleanup };
  } catch (err) {
    await root.cleanup();
    throw err;
  }
}

// A Draft rule bound to an EXISTING root config, the counterpart to createRuleFixture, which
// always builds its own flat account config. No group/condition/action: the UI authors those.
export async function createRuleOnConfig(opts: {
  namePrefix: string; table: string; rootConfigId: string; triggers?: string;
}): Promise<{ ruleId: string; ruleName: string; cleanup: () => Promise<void> }> {
  const api = createDevApi();
  const ruleName = `ZZ_RB_${opts.namePrefix}_${Math.random().toString(36).slice(2, 8)}_rule`;
  const ruleId = await api.createRecord(ENTITY_SET.rule, {
    asx_name: ruleName,
    asx_tablelogicalname: opts.table,
    asx_triggers: opts.triggers ?? "3", // Manual only, never auto-fires
    [`${BIND_NAV.ruleRootTableConfig}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${opts.rootConfigId})`,
  });
  return { ruleId, ruleName, cleanup: () => deleteRuleCascade(ruleId) };
}
