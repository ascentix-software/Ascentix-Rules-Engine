import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP, BIND_NAV } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { authorRule } from "../test-dev/ruleBehavior/authoring";
import { configsVisible } from "../test-dev/ruleBehavior/settle";
import { resolveAppId, createZzRootConfig, deleteRuleCascade } from "./devHelpers";
import { openRuleFromHub, toolbar, pickFromCombobox } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// A condition's RIGHT-HAND SIDE pointed at a related node and saved from a real browser, so that
// `BIND_NAV.conditionValueNode` ("asx_ComparisonValueNode", one of the PascalCased entries
// odata.ts:93 flags as CASE-SENSITIVE) is emitted by an actual save.
//
// WHY L2 DOES NOT COVER THIS. test-dev/bindNav.dev.test.ts round-trips all 18 nav props against
// live Dataverse, and test/editor/diff.test.ts asserts the emitted string equals the BIND_NAV
// constant, but both read the SAME constant the editor would be wrong about. The casing that
// actually ships is the one save/diff.ts writes into a PATCH/POST from the browser, and that
// path has two distinct emitters:
//   * diff.ts:450, the CREATE branch, for a condition authored from scratch in the editor;
//   * diff.ts:655, condBindChanges, the UPDATE branch, for a condition that already exists.
// One test each, below. A wrong casing surfaces as a 400 "undeclared property" on Save, or, in the
// quieter failure, the bind is dropped and the comparison silently reads the triggering record
// instead of the related one, the same failure class pinned in conditionNodeBinding.e2e.spec.ts.
//
// WHY THE FIXTURE IS A CUSTOMER→PARENT-CUSTOMER CHAIN, not the usual order tree. The RHS column
// picker is bound to `tcTable`, the CONDITION's own node table (ConditionInspector.tsx:126,220),
// while the engine reads that column off the RIGHT-HAND node's table. The two agree only when
// both nodes sit on the same table, so a same-table pair (sample_customer -> its parent customer,
// via the self-referential sample_parentcustomerid) is the one shape where the authored rule is
// semantically what the author sees. Any other pair would make this spec assert a persisted rule
// that cannot be right, whatever the bind says.
//
// ORACLE: `_asx_comparisonvaluenode_value` read straight off the persisted asx_rulecondition row,
// then the same value re-loaded into the dropdown after a hub reload, then asx_ValidateRule.
// Engine-side evaluation of a node-referencing comparison stays covered by ruleBehaviorTraversal.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const conditionOf = async (ruleId: string) => {
  const api = createDevApi();
  const groups = await api.retrieveMultipleRecords(
    ENTITY_SET.group, `?$filter=${LOOKUP.ruleOfGroup} eq ${ruleId}&$select=asx_conditiongroupid`,
  );
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.condition,
    `?$filter=_asx_conditiongroup_value eq ${groups.entities[0].asx_conditiongroupid}` +
    `&$select=asx_comparisoncolumn,asx_comparisonoperator,asx_comparisonvaluesource,` +
    `asx_comparisonvaluecolumn,${LOOKUP.conditionTableConfig},${LOOKUP.comparisonValueNode}`,
  );
  return r.entities[0] as Record<string, unknown>;
};

// GUIDs travel REST -> editor -> REST and nothing promises the casing survives identical.
const sameGuid = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();

// Root sample_customer + a self-referential Lookup node on sample_parentcustomerid. devHelpers
// builds Root and ChildTable nodes only; the Lookup field set is copied from
// test-dev/ruleBehavior/authoring.ensureTableConfig's `parent` node (asx_lookuptargetidattribute
// is required on every LookupTable node and is the TARGET table's own primary-id attribute).
// The child id needs no bookkeeping: createZzRootConfig's cleanup walks descendants depth-first.
async function customerChain(name: string) {
  const root = await createZzRootConfig(name, "sample_customer");
  try {
    const api = createDevApi();
    const parentId = await api.createRecord(ENTITY_SET.tableConfig, {
      asx_name: `${name}_parent`,
      asx_tablelogicalname: "sample_customer",
      asx_tableconfigtype: 2 /* LookupTable */,
      asx_lookupcolumnlogicalname: "sample_parentcustomerid",
      asx_lookuptargetidattribute: "sample_customerid",
      [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${root.id})`,
    });
    // The closing Validate goes through the engine's own id-filtered RetrieveMultiple, which does
    // not see a freshly created node immediately (settle.ts configsVisible).
    await configsVisible([root.id, parentId]);
    return { rootId: root.id, parentId, cleanup: root.cleanup };
  } catch (err) {
    await root.cleanup();
    throw err;
  }
}

const rand = () => Math.random().toString(36).slice(2, 8);

test("a condition authored in the editor with a related right-hand node persists asx_ComparisonValueNode", async ({ page }) => {
  const appId = await resolveAppId();
  const NAME = "ZZ_RB_cvn_new";
  const cfg = await customerChain(NAME);
  // conditions: [] still creates the (empty) VALIDATION group, so the browser can author the
  // condition straight into it via the group's "+ Condition" chip: no band ambiguity, and the
  // condition is genuinely new, which is what puts the save down diff.ts's CREATE branch.
  const rule = await authorRule({
    name: `${NAME}_${rand()}_rule`,
    rootNodeId: cfg.rootId,
    tableLogicalName: "sample_customer",
    triggers: "3", // Manual only: this rule must never fire against the shared org
    conditions: [],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: "ZZ_RB cvn probe", severity: 1 }],
    publish: false, requireValid: false, // no condition yet, so not valid until the UI adds one
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
    await frame.getByRole("button", { name: /^Edit condition/ }).click();

    // Bind the node FIRST: a new condition starts with tableConfigId: null, and nothing defaults
    // it. exact:true is load-bearing here: the parent node's name starts with the root's.
    const node = frame.getByRole("combobox", { name: "Table-config node", exact: true });
    await node.click();
    await frame.getByRole("option", { name: NAME, exact: true }).click();

    await pickFromCombobox(frame, "Comparison column", "creditlimit", /\(sample_creditlimit\)/);

    const operator = frame.getByRole("combobox", { name: "Operator" });
    await operator.click();
    await frame.getByRole("option", { name: CHOICE.operator.lessThanOrEqual, exact: true }).click();

    const source = frame.getByRole("combobox", { name: "Value source" });
    await source.click();
    await frame.getByRole("option", { name: CHOICE.valueSource.fieldReference, exact: true }).click();

    // "(same record)" is the default right-hand node, so this dropdown stays shut on the ordinary
    // authoring path and the bind is never emitted. Opening it is what makes the case meaningful.
    const rhsNode = frame.getByRole("combobox", { name: "Right-hand node" });
    await expect(rhsNode, "the default RHS is the triggering record itself").toContainText("(same record)");
    await rhsNode.click();
    await frame.getByRole("option", { name: `${NAME}_parent`, exact: true }).click();

    // Same table on both sides, so this column is real on the RHS node too. See the header note.
    await pickFromCombobox(frame, "Right-hand column", "creditlimit", /\(sample_creditlimit\)/);

    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const c = await conditionOf(rule.ruleId);
    expect(c.asx_comparisonvaluesource).toBe(2); // FieldReference
    expect(c.asx_comparisonvaluecolumn).toBe("sample_creditlimit");
    expect(sameGuid(c[LOOKUP.conditionTableConfig], cfg.rootId)).toBe(true);
    // THE assertion. A dropped bind reads as null here while every other column looks perfect,
    // and the rule would then compare the record against ITSELF, always true, silently.
    expect(sameGuid(c[LOOKUP.comparisonValueNode], cfg.parentId), "the create branch (save/diff.ts:450) must emit asx_ComparisonValueNode with exactly that casing; a null here means the browser save dropped the bind and the comparison reads the triggering record").toBe(true);

    // ROUND TRIP: the loader has to hand `comparisonValueNodeId` back
    // (load/*, LOOKUP.comparisonValueNode) or the next edit of this condition re-saves it as
    // "(same record)" without the author touching the field.
    const reloaded = await openRuleFromHub(page, appId, rule.ruleName);
    await reloaded.getByRole("button", { name: /^Edit condition/ }).click();
    await expect(reloaded.getByRole("combobox", { name: "Right-hand node" })).toContainText(`${NAME}_parent`);
    await expect(reloaded.getByRole("combobox", { name: "Right-hand column" })).toHaveValue(/\(sample_creditlimit\)/);

    await toolbar(reloaded).getByRole("button", { name: /^(Validate|Save & validate)$/ }).click();
    await expect(reloaded.getByText("Validation passed. The rule is valid.")).toBeVisible({ timeout: 30_000 });
  } finally {
    await deleteRuleCascade(rule.ruleId); // the UI-created condition isn't tracked by the fixture
    await rule.cleanup().catch(() => {});
    await cfg.cleanup();
  }
});

test("re-pointing an already-persisted condition at a related node emits the bind on the update path", async ({ page }) => {
  const appId = await resolveAppId();
  const NAME = "ZZ_RB_cvn_upd";
  const cfg = await customerChain(NAME);
  // A COMPLETE FieldReference condition that compares the record with itself: valueSource 2 and
  // a RHS column, but no valueNodeId. The only thing the browser changes is the node, so the save
  // is a pure PATCH and lands on condBindChanges (diff.ts:650-656), the emitter the create branch
  // above cannot reach.
  const rule = await authorRule({
    name: `${NAME}_${rand()}_rule`,
    rootNodeId: cfg.rootId,
    tableLogicalName: "sample_customer",
    triggers: "3",
    conditions: [{
      nodeId: cfg.rootId, conditionType: 1, column: "sample_creditlimit",
      operator: 6 /* LessThanOrEqual */, valueSource: 2, valueColumn: "sample_creditlimit",
    }],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: "ZZ_RB cvn probe", severity: 1 }],
    publish: false, requireValid: false,
  });
  try {
    // Precondition, asserted rather than assumed: without it a bind that was never emitted is
    // indistinguishable from one that was already there.
    const before = await conditionOf(rule.ruleId);
    expect(before[LOOKUP.comparisonValueNode] ?? null).toBeNull();

    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: /^Edit condition/ }).click();

    const rhsNode = frame.getByRole("combobox", { name: "Right-hand node" });
    await rhsNode.click();
    await frame.getByRole("option", { name: `${NAME}_parent`, exact: true }).click();

    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const after = await conditionOf(rule.ruleId);
    expect(sameGuid(after[LOOKUP.comparisonValueNode], cfg.parentId), "the update branch (save/diff.ts:655) must PATCH asx_ComparisonValueNode; a null here means the editor reported 'Saved.' over a change it never sent").toBe(true);
    // Nothing else may have moved: condBindChanges runs alongside changedAttrs, and a bind change
    // that also rewrote the comparison column would be a different, quieter defect.
    expect(after.asx_comparisonvaluecolumn).toBe("sample_creditlimit");
    expect(after.asx_comparisonvaluesource).toBe(2);
  } finally {
    await deleteRuleCascade(rule.ruleId);
    await rule.cleanup().catch(() => {});
    await cfg.cleanup();
  }
});
