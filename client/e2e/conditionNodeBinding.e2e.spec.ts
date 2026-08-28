import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP, BIND_NAV } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createOrderConfigTree, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, saveValidatePublish } from "./editorHarness";
import { CHOICE } from "./liveLabels";
import { saveOrderViaForm } from "./formSaveOracle";

// Every condition must carry a table-config node binding, and nothing may let an unbound one
// through. This file pins both defences: the editor's and the server's.
//
// Why an unbound condition is dangerous. The chain:
//   1. `model/reducer.ts` newCondition() starts `tableConfigId: null`.
//   2. Nothing defaults it. `ConditionInspector.tsx:250-256` renders the "Table-config node"
//      dropdown with `value=""` and no preselection, so an author who never opens that dropdown
//      leaves it null. The COLUMN picker meanwhile falls back to the rule's root table
//      (`ConditionInspector.tsx:220`), so the condition looks completely filled in.
//   3. `save/diff.ts:399` omits `asx_tableconfig@odata.bind` when the id is null: the row is
//      written with a null lookup.
//   4. If `asx_ValidateRule` were to return isValid: true, publish succeeds and the badge says
//      Published.
//   5. Every subsequent write to the table throws
//      `0x80040265 "Condition <id> references table-config node 00000000-0000-0000-0000-000000000000
//      which is not in the rule's config tree."`
//
// So an unbound condition is not a corner case: it is what the default path through the editor
// would produce: add a group, add a condition, pick a column and an operator, type a value,
// Save/Validate/Publish. A node filter left blank fails the same way, but that one at least
// needs an untouched auto-seeded row. Related shapes, for orientation: binding a condition to a
// CHILD node is rejected at validate with META_COLUMN_NOT_FOUND, and the root config's
// cardinality makes no difference either way.
//
// The two defences are independent, which is why both are pinned here:
//   (1) EDITOR: a new condition's tableConfigId defaults to the rule's root config node, so the
//       happy path produces a valid rule. The dropdown stays editable for multi-node rules. The
//       first test walks that path in the browser without ever opening the node dropdown, then
//       requires the published rule to ENFORCE (150 blocked, 50 saved) rather than hard-error.
//   (2) CORE: `asx_ValidateRule` fails a condition whose node binding is null or not in the
//       rule's config tree, with a STRUCT_* issue. Validation passing a rule the engine then
//       refuses to run is the deeper failure. The editor default alone would leave every
//       REST/ISV author exposed. The second test authors that condition over the Web API.
//
// Both defences have to be DEPLOYED for this file to pass: e2e drives the deployed bundle and
// the deployed plugin assembly.

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await sweepRuleBehaviorOrphans();
});

test("a condition authored without touching the node dropdown is caught before it can brick the table", async ({ page }) => {
  const appId = await resolveAppId();
  const tree = await createOrderConfigTree("ZZ_RB_cnb_cfg");
  const rule = await createRuleOnConfig({
    namePrefix: "cnb",
    table: "sample_order",
    rootConfigId: tree.rootId,
    triggers: "1,4",
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);

    // The happy path, exactly as a first-time author walks it. The "Table-config node"
    // dropdown is deliberately never opened.
    // The VALIDATION band (GraphTree.tsx:262-276 renders execution first, validation second).
    // `.first()` would author into the EXECUTION band, which gates whether the rule runs rather
    // than deciding a match, so nth(1) is the validation band, which is what decides a match here.
    await frame.getByRole("button", { name: "+ Add group" }).nth(1).click();
    await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
    await frame.getByRole("button", { name: /^Edit condition/ }).click();
    const columnBox = frame.getByRole("combobox", { name: "Comparison column" });
    await columnBox.click();
    await frame.getByRole("option").first().waitFor({ state: "visible", timeout: 30_000 });
    await columnBox.pressSequentially("ordertotal", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_ordertotal\)/ }).first().click();
    const operatorBox = frame.getByRole("combobox", { name: "Operator" });
    await operatorBox.click();
    await frame.getByRole("option", { name: CHOICE.operator.lessThanOrEqual, exact: true }).click();
    await frame.getByRole("textbox", { name: "Value" }).fill("100");

    await frame.getByRole("button", { name: "+ Add action" }).click();
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();
    const type = frame.getByRole("combobox", { name: "Action type" });
    await type.click();
    await frame.getByRole("option", { name: CHOICE.actionType.block, exact: true }).click();
    await frame.getByRole("textbox", { name: "Block message" }).fill("ZZ_RB node-binding pin");
    const fireOn = frame.getByRole("combobox", { name: "Fire on" });
    await fireOn.click();
    await frame.getByRole("option", { name: CHOICE.fireOn.onNoMatch, exact: true }).click();

    // Defence (1): the editor defaults the binding to the rule's root node, so
    // Save/Validate/Publish all succeed and the persisted condition points somewhere real.
    await saveValidatePublish(frame);

    const api = createDevApi();
    const groups = await api.retrieveMultipleRecords(
      ENTITY_SET.group,
      `?$filter=${LOOKUP.ruleOfGroup} eq ${rule.ruleId}&$select=asx_conditiongroupid`,
    );
    const groupIds = groups.entities.map((g) => String(g.asx_conditiongroupid));
    const conditions = await api.retrieveMultipleRecords(
      ENTITY_SET.condition,
      `?$filter=${groupIds.map((id) => `_asx_conditiongroup_value eq ${id}`).join(" or ")}` +
      `&$select=asx_ruleconditionid,${LOOKUP.conditionTableConfig}`,
    );
    expect(
      conditions.entities[0][LOOKUP.conditionTableConfig],
      "the editor left the condition's table-config node null",
    ).toBe(tree.rootId);

    // ... and because the binding is real, the rule enforces instead of hard-erroring:
    // 150 is blocked by the rule, 50 saves.
    expect(await saveOrderViaForm(page, "ZZ_RB_cnb_violating", 150, "BLOCKED")).toBe("BLOCKED");
    expect(await saveOrderViaForm(page, "ZZ_RB_cnb_compliant", 50, "SAVED")).toBe("SAVED");
  } finally {
    await rule.cleanup();
    await tree.cleanup();
  }
});

test("asx_ValidateRule rejects a condition whose node binding is not in the rule's config tree", async () => {
  // Defence (2), the REST-side half, kept next to its sibling so neither is dropped alone.
  // An ISV or a script authoring rules through the Web API reaches this with no editor involved:
  // create a condition with no asx_tableconfig bind and call asx_ValidateRule. The verdict has to
  // be a structural failure, not isValid:true.
  const tree = await createOrderConfigTree("ZZ_RB_cnb_api_cfg");
  const rule = await createRuleOnConfig({
    namePrefix: "cnbapi",
    table: "sample_order",
    rootConfigId: tree.rootId,
    triggers: "1,4",
  });
  const api = createDevApi();
  try {
    const groupId = await api.createRecord(ENTITY_SET.group, {
      asx_name: "ZZ_RB_cnb_api_grp",
      asx_logicaloperator: 1,
      asx_isexecutioncondition: false,
      [`${BIND_NAV.groupRule}@odata.bind`]: `/${ENTITY_SET.rule}(${rule.ruleId})`,
    });
    // Bind names come from BIND_NAV, never hand-written: the @odata.bind casing contract
    // lives in src/editor/load/odata.ts, and a literal "asx_Rule" 400s as an
    // undeclared property, which is exactly how this test first failed.
    // Note the absence of any asx_tableconfig bind: that is the whole point.
    await api.createRecord(ENTITY_SET.condition, {
      asx_name: "ZZ_RB_cnb_api_cond",
      asx_conditiontype: 1,
      asx_comparisoncolumn: "sample_ordertotal",
      asx_comparisonoperator: 6,
      asx_comparisonvaluesource: 1,
      asx_comparisonvalue: "100",
      [`${BIND_NAV.conditionGroup}@odata.bind`]: `/${ENTITY_SET.group}(${groupId})`,
    });

    const verdict = await api.validateRule(rule.ruleId);
    expect(verdict.isValid, "a condition with no table-config node validated as valid").toBe(false);
    expect(JSON.stringify(verdict.issues)).toMatch(/STRUCT_/);
  } finally {
    await rule.cleanup();
    await tree.cleanup();
  }
});
