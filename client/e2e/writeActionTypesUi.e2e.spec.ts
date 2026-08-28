import { test, expect } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { resolveAppId, createOrderConfigTree, createRuleOnConfig } from "./devHelpers";
import { openRuleFromHub, toolbar } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// CreateRecord and DeleteRecord authored end-to-end in the browser: CreateRecord's TablePicker
// over live table metadata plus the mapping dialog's literal and "From this record" sources, and
// DeleteRecord's target-node gating. (writeActionUi.e2e covers the third write type, UpdateRecord
// against the ROOT node, with literal values only.) The mapping dialog's non-literal sources are
// otherwise only exercised in jsdom.
//
// Oracle: asx_targettable / asx_targetnode and the asx_fieldmapping JSON, which is the engine
// contract (Core/Actions/FieldMappingParser.cs), so a mis-serialised entry is a silent
// production failure, not a cosmetic one. Execution itself stays covered by ruleBehaviorWrite.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

const actionOf = async (ruleId: string) => {
  const api = createDevApi();
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.action,
    `?$filter=${LOOKUP.ruleOfAction} eq ${ruleId}` +
    `&$select=asx_actiontype,asx_targettable,asx_fieldmapping,${LOOKUP.actionTargetNode}`,
  );
  return r.entities[0] as Record<string, unknown>;
};

async function addActionOfType(frame: Awaited<ReturnType<typeof openRuleFromHub>>, label: string) {
  await frame.getByRole("button", { name: "+ Add action" }).click();
  await frame.getByRole("button", { name: /^Edit action 1/ }).click();
  const type = frame.getByRole("combobox", { name: "Action type" });
  await type.click();
  await frame.getByRole("option", { name: label, exact: true }).click();
}

test("CreateRecord authored in the UI: target table plus literal and from-this-record mappings", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("wtui_cr");
  const rule = await createRuleOnConfig({
    namePrefix: "wtui_cr", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await addActionOfType(frame, CHOICE.actionType.createRecord);

    // TablePicker: a freeform Combobox over LIVE table metadata, not a fixed list.
    const table = frame.getByRole("combobox", { name: "Target table" });
    await table.click();
    await table.pressSequentially("sample_orderline", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_orderline\)/ }).click();

    await frame.getByRole("button", { name: "Edit columns…" }).click();

    // Mapping 1: literal into the line's primary name column.
    await frame.getByRole("button", { name: "Add column" }).first().click();
    const col1 = frame.getByRole("combobox", { name: "Column 1", exact: true });
    await col1.click();
    await col1.pressSequentially("sample_name", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_name\)/ }).click();
    await frame.getByRole("textbox", { name: /^Value for/ }).fill("ZZ_RB created line");

    // Mapping 2, "From this record": copies a column off the triggering row. It serialises
    // differently ({ source: "root", column }) from a literal ({ source: "literal", value }),
    // so both shapes have to survive the same round-trip.
    await frame.getByRole("button", { name: "Add column" }).first().click();
    const col2 = frame.getByRole("combobox", { name: "Column 2", exact: true });
    await col2.click();
    await col2.pressSequentially("notes", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_notes\)/ }).click();

    const source2 = frame.getByRole("combobox", { name: /^Source for/ });
    await source2.click();
    await frame.getByRole("option", { name: "From this record", exact: true }).click();

    // The value control is now a ColumnPicker over the RULE's table, kind-compatible with the
    // target column (text → text).
    const from2 = frame.getByRole("combobox", { name: /^Value for/ });
    await from2.click();
    await from2.pressSequentially("approval", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_approvalnotes\)/ }).click();

    await expect(frame.getByText("Ready to apply")).toBeVisible();
    await frame.getByRole("button", { name: "Apply", exact: true }).click();

    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const action = await actionOf(rule.ruleId);
    expect(action.asx_actiontype).toBe(5); // CreateRecord
    expect(action.asx_targettable).toBe("sample_orderline");

    const mapping = JSON.parse(String(action.asx_fieldmapping)) as Record<string, unknown>[];
    expect(mapping).toEqual([
      { target: "sample_name", source: "literal", value: "ZZ_RB created line" },
      { target: "sample_notes", source: "root", column: "sample_approvalnotes" },
    ]);
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});

test("DeleteRecord authored in the UI: only single-cardinality nodes are offered as the target", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("wtui_dr");
  const rule = await createRuleOnConfig({
    namePrefix: "wtui_dr", table: "sample_order", rootConfigId: cfg.rootId,
  });
  try {
    const frame = await openRuleFromHub(page, appId, rule.ruleName);
    await addActionOfType(frame, CHOICE.actionType.deleteRecord);

    const node = frame.getByRole("combobox", { name: "Target node" });
    await node.click();

    // The child COLLECTION must not be offered: the engine's NodeCardinality.EnsureSingle
    // rejects a many-cardinality target, so offering it would author a rule that only fails
    // at runtime. The root (single) is the one legitimate choice.
    await expect(frame.getByRole("option", { name: /_line$/ })).toHaveCount(0);
    await frame.getByRole("option", { name: /ZZ_RB_wtui_dr/ }).first().click();

    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const action = await actionOf(rule.ruleId);
    expect(action.asx_actiontype).toBe(7); // DeleteRecord
    expect(action[LOOKUP.actionTargetNode]).toBe(cfg.rootId);
  } finally {
    await rule.cleanup();
    await cfg.cleanup();
  }
});
