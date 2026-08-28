import { test, expect } from "@playwright/test";
import type { FrameLocator, Locator } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { authorRule } from "../test-dev/ruleBehavior/authoring";
import {
  resolveAppId, createZzRootConfig, createOrderConfigTree, createRuleOnConfig, deleteRuleCascade,
} from "./devHelpers";
import { openRuleFromHub, toolbar } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// Two authoring surfaces driven through real Fluent controls: the RowCount mode dropdown, and the
// "Insert field" token menus in the Block/ShowMessage message editors.
//
//   * ROW-COUNT MODES. The mode is DERIVED from the stored min/max pair, never stored
//     (countMode.tsx:8-21, applied at :37-55), so a wrong derivation changes the rule's meaning
//     with nothing on screen to say so: "None (does not exist)" that persists min=null/max=null is
//     a condition that matches EVERY record, the exact inverse of what the author asked for.
//     applyCountMode's seeding rules carry scars from that: the `atLeast` seed >= 2 branch (:46)
//     exists because "At least 1" collapsed straight back into "At least one (exists)", and the
//     "Between N and M" case in conditionTypesUi.e2e.spec.ts exists because the dropdown
//     re-derived its mode mid-edit and discarded the range. The oracle here is therefore the
//     persisted asx_minexpectedrows/asx_maxexpectedrows pair, not the dropdown.
//
//   * INSERT-FIELD TOKENS in the MessageEditor (ActionInspector.tsx:33-57) and in a TranslationRow
//     (:60-87). The two hosts are genuinely different code paths: the message body splices off an
//     HTMLTextAreaElement's selectionStart (:39-42), the translation row off an HTMLInputElement's
//     (:66-69). A real caret in a real controlled input is what makes the splice meaningful.
//     This is user-facing text, so a wrong token becomes visible garbage in front of a real user.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const rand = () => Math.random().toString(36).slice(2, 8);

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
      `&$select=asx_name,asx_conditiontype,asx_minexpectedrows,asx_maxexpectedrows,` +
      `${LOOKUP.conditionTableConfig}`,
    );
    out.push(...(r.entities as Record<string, unknown>[]));
  }
  return out;
};

const byName = (rows: Record<string, unknown>[], name: string) => {
  const hit = rows.filter((r) => r.asx_name === name);
  expect(hit.length, `exactly one persisted condition named ${name}`).toBe(1);
  return hit[0];
};

test("the five never-authored count modes each persist the min/max pair their semantics require", async ({ page }) => {
  const appId = await resolveAppId();
  const CFG = "ZZ_RB_cm";
  const cfg = await createOrderConfigTree(CFG); // root sample_order + ZZ_RB_cm_line collection
  const rule = await createRuleOnConfig({
    namePrefix: "cm", table: "sample_order", rootConfigId: cfg.rootId,
  });

  // Five RowCount conditions in ONE group and ONE save. Every mode is exercised against the same
  // live component instance, which is also where the two known defects lived: CountModeFields
  // holds the chosen mode in React state and re-derives it whenever the incoming pair is not the
  // one it last emitted (countMode.tsx:87-98), so switching between conditions is part of what is
  // under test. Modes are ordered with `custom` LAST on purpose: selecting "custom" on a fresh
  // condition emits (null, null), which is also a fresh condition's own pair: putting it earlier
  // would let the component keep a stale `chosen` across the selection change and mask a real
  // re-derivation failure.
  const CASES = [
    // name suffix        dropdown label            input(s) to fill        expected persisted pair
    { key: "none", label: "None (does not exist)", fills: [] as { name: string; seed: string; to: string }[], min: null, max: 0 },
    { key: "atleast", label: "At least N", fills: [{ name: "Count", seed: "2", to: "3" }], min: 3, max: null },
    { key: "atmost", label: "At most N", fills: [{ name: "Count", seed: "1", to: "4" }], min: null, max: 4 },
    { key: "exactly", label: "Exactly N", fills: [{ name: "Count", seed: "1", to: "2" }], min: 2, max: 2 },
    {
      key: "custom", label: "Custom (min / max)",
      fills: [{ name: "Min expected rows", seed: "", to: "7" }, { name: "Max expected rows", seed: "", to: "9" }],
      min: 7, max: 9,
    },
  ];

  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: "+ Add group" }).first().click();

    for (const c of CASES) {
      const condName = `ZZ_RB_cm_${c.key}`;
      await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
      // A RowCount condition's aria-label carries only its node (labels.ts:50 leaves `field` null),
      // so all five rows end up identically named. The one just added is picked with .last(), and
      // the persisted rows are told apart by the name typed below instead.
      await frame.getByRole("button", { name: /^Edit condition/ }).last().click();

      await frame.getByRole("textbox", { name: "Condition name" }).fill(condName);

      const node = frame.getByRole("combobox", { name: "Table-config node", exact: true });
      await node.click();
      await frame.getByRole("option", { name: /_line$/ }).click();

      const type = frame.getByRole("combobox", { name: "Condition type" });
      await type.click();
      await frame.getByRole("option", { name: CHOICE.conditionType.rowCount, exact: true }).click();

      const mode = frame.getByRole("combobox", { name: "Row count mode" });
      // A fresh condition stores (null, null), which deriveRowCountMode reports as "custom", so
      // the raw min/max inputs are what an author sees before choosing anything.
      await expect(mode).toContainText("Custom (min / max)");
      await mode.click();
      await frame.getByRole("option", { name: c.label, exact: true }).click();
      await expect(mode).toContainText(c.label);

      // The SEEDED value is asserted before it is overwritten. This is where applyCountMode's
      // rules actually live: "At least N" must seed 2, never 1: a seed of 1 makes the stored pair
      // (1, null), which deriveRowCountMode reads back as `atLeastOne`, snapping the dropdown and
      // hiding the input the moment the author selects the mode.
      for (const f of c.fills) {
        const box = frame.getByRole("spinbutton", { name: f.name });
        await expect(box, `${c.label} seeds "${f.name}" with ${f.seed || "(empty)"}`).toHaveValue(f.seed);
        await box.fill(f.to);
      }
      if (c.fills.length === 0) {
        // "None" is expressed entirely by the pair (null, 0): there is nothing to type, and an
        // input appearing here would mean applyCountMode landed on a different mode.
        await expect(frame.getByRole("spinbutton", { name: "Count" })).toHaveCount(0);
        await expect(frame.getByRole("spinbutton", { name: "Minimum" })).toHaveCount(0);
      }
      // The two-input modes must keep BOTH inputs mounted; a collapse to a single "Count" is the
      // shape of the already-fixed between->exactly defect.
      if (c.fills.length === 2) {
        await expect(frame.getByRole("spinbutton", { name: "Count" })).toHaveCount(0);
      }
    }

    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const rows = await conditionsOf(rule.ruleId);
    expect(rows.length).toBe(5);
    for (const c of CASES) {
      const r = byName(rows, `ZZ_RB_cm_${c.key}`);
      expect(r.asx_conditiontype, `${c.label} is a RowCount condition`).toBe(2);
      expect(r[LOOKUP.conditionTableConfig]).toBe(cfg.childId);
      // `?? null` on both sides: an absent attribute and an explicit null are the same thing here,
      // but 0 must NOT be flattened into null: that difference IS the "None" semantic.
      expect(r.asx_minexpectedrows ?? null, `${c.label} persists min=${c.min}`).toBe(c.min);
      expect(r.asx_maxexpectedrows ?? null, `${c.label} persists max=${c.max}`).toBe(c.max);
    }

    // Spelled out because it is the single highest-value line in the case: "None (does not exist)"
    // means max=0, and a max of null instead would make the condition match every record, the
    // exact inverse of the author's intent, with an identical-looking dropdown.
    expect(byName(rows, "ZZ_RB_cm_none").asx_maxexpectedrows,
      "'None (does not exist)' must persist max=0; a null max matches EVERY record").toBe(0);
  } finally {
    await rule.cleanup(); // deleteRuleCascade: the group and all five conditions came from the UI
    await cfg.cleanup();
  }
});

// Walk "Insert field ▸ This record ▸ <column>" from a SPECIFIC trigger button. editorHarness's
// pickFromMenu locates its trigger frame-wide, which strict-mode-fails the moment a translation
// row adds a second "Insert field" button to the same inspector, so the trigger is passed in.
// Nested Fluent MenuItem triggers open on HOVER, not click (conditionTypesUi.e2e.spec.ts:183-185);
// the popovers are portalled to the document body, so the items themselves are located frame-wide.
// This inspector is NOT inside a modal dialog, so role-based locators are correct here. The
// aria-hidden trap documented in aggregateFiltersUi is specific to FieldMappingDialog.
async function insertField(frame: FrameLocator, trigger: Locator, column: RegExp) {
  await trigger.click();
  const root = frame.getByRole("menuitem", { name: "This record", exact: true }).first();
  await root.waitFor({ state: "visible", timeout: 30_000 });
  await root.hover();
  const col = frame.getByRole("menuitem", { name: column }).first();
  await col.waitFor({ state: "visible", timeout: 30_000 });
  await col.click();
}

test("Insert field splices a {root.x} token at the caret in a message body and in a translation row", async ({ page }) => {
  const appId = await resolveAppId();
  const CFG = "ZZ_RB_tok";
  const cfg = await createZzRootConfig(CFG, "sample_order");
  // Root-only on purpose: InsertFieldMenu's `insertableNodes` (:44-47) keeps single-cardinality
  // saved nodes, so a config with no related node offers exactly one branch ("This record") and
  // the menu under test is unambiguous. (The {node:<id>.<col>} branch is a different case.)
  const rule = await authorRule({
    name: `${CFG}_${rand()}_rule`,
    rootNodeId: cfg.id,
    triggers: "3", // Manual only: this rule must never fire against the shared org
    conditions: [{
      nodeId: cfg.id, conditionType: 1, column: "sample_ordertotal",
      operator: 4 /* GreaterThanOrEqual */, valueSource: 1, literal: "0",
    }],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: "ZZ_RB token seed", severity: 1 }],
    publish: false, requireValid: false,
  });

  // Anchored so the Money column's auto-generated sibling ("Order Total (Base)") cannot match.
  const ORDER_TOTAL = /^Order Total$/;
  const POSTAL = /^Shipping Postal Code$/;
  const MESSAGE = "{root.sample_shippingpostalcode}ZZ_RB total is {root.sample_ordertotal}";
  const FRENCH = "{root.sample_ordertotal}ZZ_RB fr end";

  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await frame.getByRole("button", { name: /^Edit action 1/ }).click();

    // --- the TEXTAREA host (MessageEditor) --------------------------------------------------
    const body = frame.getByRole("textbox", { name: "Show-message message" });
    await body.fill("ZZ_RB total is ");
    await insertField(frame, frame.getByRole("button", { name: "Insert field", exact: true }), ORDER_TOTAL);
    await expect(body, "the menu must emit the {root.<logicalName>} grammar, not a display label").toHaveValue(
      "ZZ_RB total is {root.sample_ordertotal}",
    );

    // Move the caret to the very start and insert again. A menu that ignored selectionStart would
    // append the second token too, and the author who put their cursor mid-sentence would watch
    // the field land at the end of the message their user actually reads.
    await body.press("Home");
    await insertField(frame, frame.getByRole("button", { name: "Insert field", exact: true }), POSTAL);
    await expect(body, "the token must be spliced AT THE CARET (ActionInspector.tsx:39-42), not appended").toHaveValue(MESSAGE);

    // The preview line is the only thing standing between the author and a wall of logical names.
    const preview = frame.getByText(/^Preview:/).first();
    await expect(preview).toContainText("{Shipping Postal Code}ZZ_RB total is {Order Total}");
    await expect(preview, "friendlyTemplate must resolve tokens to display names, never leak the raw column").not.toContainText("sample_ordertotal");

    // --- the INPUT host (TranslationRow), a different ref type and a different splice site ---
    const addLang = frame.getByRole("combobox", { name: "Translations (fallback = message above)" });
    await addLang.click();
    await frame.getByRole("option", { name: /French \(1036\)/ }).click();

    const row = frame.getByText("French (1036)").locator("xpath=..");
    const frInput = row.getByRole("textbox");
    await frInput.fill("ZZ_RB fr end");
    await frInput.press("Home");
    await insertField(frame, row.getByRole("button", { name: "Insert field", exact: true }), ORDER_TOTAL);
    await expect(frInput, "the translation row splices off an <Input>'s selectionStart (ActionInspector.tsx:66-69)").toHaveValue(FRENCH);

    await expect(frame.getByText("Unsaved changes")).toBeVisible();
    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    // --- the oracle: both messages VERBATIM on the rows the engine renders from ---------------
    const api = createDevApi();
    const acts = await api.retrieveMultipleRecords(
      ENTITY_SET.action,
      `?$filter=${LOOKUP.ruleOfAction} eq ${rule.ruleId}&$select=asx_ruleactionid,asx_message`,
    );
    expect(acts.entities.length).toBe(1);
    expect(acts.entities[0].asx_message,
      "the message must persist byte-identically — Core/Execution/TemplateRenderer parses these braces").toBe(MESSAGE);

    const msgs = await api.retrieveMultipleRecords(
      ENTITY_SET.localizedMessage,
      `?$filter=_asx_ruleaction_value eq ${acts.entities[0].asx_ruleactionid}` +
      `&$select=asx_languagecode,asx_message`,
    );
    expect(msgs.entities.length).toBe(1);
    expect(msgs.entities[0].asx_languagecode).toBe(1036);
    expect(msgs.entities[0].asx_message).toBe(FRENCH);

    // A token the editor emits but the SERVER validator rejects would be the worst outcome of the
    // three, so it is checked last and on the saved rule: everything above already round-tripped.
    await toolbar(frame).getByRole("button", { name: "Validate" }).click();
    await expect(frame.getByText("Validation passed. The rule is valid.")).toBeVisible({ timeout: 30_000 });
  } finally {
    await deleteRuleCascade(rule.ruleId); // reclaims the UI-authored asx_localizedmessage row
    await rule.cleanup().catch(() => {});
    await cfg.cleanup();
  }
});
