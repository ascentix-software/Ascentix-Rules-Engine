import { test, expect } from "@playwright/test";
import type { FrameLocator } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createOrderConfigTree, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, toolbar, pickFromMenu } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// The Insert-aggregate menu, exercised in a real browser: `avg`, `min`, `max` and `count` are
// authored into an Expression condition FROM THE MENU (not hand-written into the expression
// column), saved, and read back.
//
// Two things only a browser can prove here:
//   1. InsertAggregateMenu's numeric-column filter (InsertFieldMenu.tsx:137) runs `columnKind`
//      (columnKind.ts:9) over LIVE Dataverse `attributeType` strings
//      (Money/Decimal/Double/Integer/BigInt), not a jsdom fixture's made-up types.
//   2. `count` takes a structurally different branch (InsertFieldMenu.tsx:153-158): a collection
//      needs no column, so its submenu is two levels deep where every other function is three.
//      Emitting `count(node:<id>.<col>)` is rejected by mathExpr.ts:50 ("count(...) takes no
//      column"), which stops the expression parsing and the author cannot save; emitting a
//      mis-cased function name instead reaches Core/Execution/MathExpr.cs and fails at RUNTIME,
//      not at Validate. Hence its own test.
//
// ORACLE: the persisted `asx_conditionexpression`, AND the same expression read back out of the
// editor's textarea after a hub reload. A save-only assertion would miss a serialization defect
// on the load side (the expression is a free-text column, so nothing else would complain); the
// round-trip is the point of the case.

test.beforeAll(async () => {
  // The sweep runs long when a red run left orphans behind; the file-scope hook otherwise
  // inherits the config's 90 s and fails the WHOLE file with a hook timeout.
  test.setTimeout(180_000);
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const conditionsOf = async (ruleId: string) => {
  const api = createDevApi();
  const groups = await api.retrieveMultipleRecords(
    ENTITY_SET.group, `?$filter=${LOOKUP.ruleOfGroup} eq ${ruleId}&$select=asx_conditiongroupid`,
  );
  const out: Record<string, unknown>[] = [];
  for (const g of groups.entities) {
    const r = await api.retrieveMultipleRecords(
      ENTITY_SET.condition,
      `?$filter=_asx_conditiongroup_value eq ${g.asx_conditiongroupid}` +
      `&$select=asx_conditiontype,asx_conditionexpression,asx_comparisonvalue`,
    );
    out.push(...(r.entities as Record<string, unknown>[]));
  }
  return out;
};

// The MathExprEditor's Textarea carries no accessible label (primitives.Field renders a plain
// <span>, not a <label htmlFor>), so it is located by its placeholder. The distinctive tail
// "+ - * / and ( )" belongs to MathExprEditor alone: TemplateEditor's placeholder also contains
// "use Insert field", so a shorter substring would collide once both editors are on screen.
const exprBox = (frame: FrameLocator) => frame.getByPlaceholder("+ - * / and ( )");

// Add an execution group + one condition and open that condition's inspector, then switch it to
// Calculation (liveLabels.ts: the org's label for conditionType 4 Expression).
async function openExpressionCondition(page: Parameters<typeof openRuleFromHub>[0], appId: string, ruleName: string) {
  const frame = await openRuleFromHub(page, appId, ruleName);
  // .first() is the EXECUTION band's empty-state CTA. That band gates whether the rule runs
  // rather than deciding a match, which matters for a Block rule but not here, where the oracle
  // is the persisted expression. conditionTypesUi's Expression case uses the same band.
  await frame.getByRole("button", { name: "+ Add group" }).first().click();
  await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
  await frame.getByRole("button", { name: /^Edit condition/ }).click();
  const type = frame.getByRole("combobox", { name: "Condition type" });
  await type.click();
  await frame.getByRole("option", { name: CHOICE.conditionType.expression, exact: true }).click();
  return frame;
}

// A new condition starts with tableConfigId = the rule's ROOT node (reducer.ts:102), so an
// Expression condition needs no node pick, but the aggregate token it carries names the CHILD
// collection explicitly, which is what these regexes pin. Case-insensitive because the config
// node id travels REST → editor → REST and nothing guarantees the GUID casing survives identical.
const aggToken = (fn: string, nodeId: string, column?: string) =>
  `${fn}(node:${nodeId}${column ? `.${column}` : ""})`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactly = (s: string) => new RegExp(`^${escapeRe(s)}$`, "i");

test("Expression: avg, min and max authored from the Insert-aggregate menu survive a save and reload", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("aggfn_amm");
  const rule = await createRuleOnConfig({
    namePrefix: "aggfn_amm", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openExpressionCondition(page, appId, rule.ruleName);
    const ta = exprBox(frame);

    // Each function is asserted on its OWN, immediately after insertion, before the next one is
    // appended, so a wrong emission is attributed to the function that produced it rather than
    // to "the final expression is wrong". `Line Amount` is sample_lineamount (Money); it is only
    // offered because columnKind maps the live attributeType to "number" (InsertFieldMenu.tsx:137).
    const LINE_AMOUNT = /Line [Aa]mount|sample_lineamount/;

    await pickFromMenu(frame, "Insert aggregate", ["Average", /_line$/, LINE_AMOUNT]);
    const avg = aggToken("avg", cfg.childId, "sample_lineamount");
    await expect(ta, "the Average menu item must emit avg(...), not average(...) — Core/Execution/MathExpr.cs only knows the short form").toHaveValue(exactly(avg));

    // Type the operator rather than splicing it in: MathExprEditor inserts at the textarea's
    // selectionStart, so the caret has to be parked at the end before the next menu insert or the
    // token is PREPENDED. Control+End also exercises the typed-arithmetic grammar (mathExpr.ts:55-98)
    // against the real controlled Fluent Textarea, which jsdom cannot reproduce.
    await ta.press("Control+End");
    await ta.pressSequentially(" + ", { delay: 30 });

    await pickFromMenu(frame, "Insert aggregate", ["Min", /_line$/, LINE_AMOUNT]);
    const min = aggToken("min", cfg.childId, "sample_lineamount");
    await expect(ta).toHaveValue(exactly(`${avg} + ${min}`));

    await ta.press("Control+End");
    await ta.pressSequentially(" + ", { delay: 30 });

    await pickFromMenu(frame, "Insert aggregate", ["Max", /_line$/, LINE_AMOUNT]);
    const max = aggToken("max", cfg.childId, "sample_lineamount");
    const EXPECTED = `${avg} + ${min} + ${max}`;
    await expect(ta).toHaveValue(exactly(EXPECTED));

    // Expression conditions expose only the six numeric operators (ConditionInspector.tsx:312).
    const operator = frame.getByRole("combobox", { name: "Operator" });
    await operator.click();
    await frame.getByRole("option", { name: CHOICE.operator.greaterThan, exact: true }).click();
    await frame.getByRole("textbox", { name: "Value" }).fill("100");

    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_conditiontype).toBe(4); // Expression
    expect(String(c.asx_conditionexpression).toLowerCase()).toBe(EXPECTED.toLowerCase());

    // ROUND-TRIP. A save-only assertion proves the editor SERIALISED the three tokens; it says
    // nothing about whether the load path hands them back. Re-open from the hub (a real reload
    // into ?view=rule&id=…, see devHelpers.hubDeepLink) and read the textarea again.
    const reloaded = await openRuleFromHub(page, appId, rule.ruleName);
    await reloaded.getByRole("button", { name: /^Edit condition/ }).click();
    await expect(exprBox(reloaded)).toHaveValue(exactly(EXPECTED));
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

test("Expression: Count authored from the Insert-aggregate menu takes a collection and no column", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("aggfn_cnt");
  const rule = await createRuleOnConfig({
    namePrefix: "aggfn_cnt", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openExpressionCondition(page, appId, rule.ruleName);
    const ta = exprBox(frame);

    // The count branch (InsertFieldMenu.tsx:153-158) renders the collections as plain MenuItems,
    // NOT as MenuTriggers with a column submenu, so the path is two levels, not three, and the
    // click lands on the collection itself. This assertion is the branch discriminator: if count
    // ever grew a column level, the collection item would be a submenu trigger, clicking it would
    // only open that submenu, no token would be emitted, and this expect would time out. If it
    // instead emitted a column, the value would be count(node:<id>.<col>), which mathExpr.ts:50
    // rejects outright ("count(...) takes no column"), leaving the author unable to save.
    await pickFromMenu(frame, "Insert aggregate", ["Count", /_line$/]);
    const EXPECTED = aggToken("count", cfg.childId);
    await expect(ta).toHaveValue(exactly(EXPECTED));

    const operator = frame.getByRole("combobox", { name: "Operator" });
    await operator.click();
    await frame.getByRole("option", { name: CHOICE.operator.greaterThanOrEqual, exact: true }).click();
    await frame.getByRole("textbox", { name: "Value" }).fill("2");

    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const [c] = await conditionsOf(rule.ruleId);
    expect(c.asx_conditiontype).toBe(4);
    expect(String(c.asx_conditionexpression).toLowerCase()).toBe(EXPECTED.toLowerCase());
    expect(c.asx_comparisonvalue).toBe("2");

    // Round-trip: the column-less form is the one most likely to be "helpfully" normalised by a
    // loader that assumes every aggregate has a column.
    const reloaded = await openRuleFromHub(page, appId, rule.ruleName);
    await reloaded.getByRole("button", { name: /^Edit condition/ }).click();
    await expect(exprBox(reloaded)).toHaveValue(exactly(EXPECTED));
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});
