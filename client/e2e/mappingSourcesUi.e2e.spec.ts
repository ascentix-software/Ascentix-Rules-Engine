import { test, expect } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP, BIND_NAV } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { authorRule } from "../test-dev/ruleBehavior/authoring";
import { configsVisible } from "../test-dev/ruleBehavior/settle";
import { resolveAppId, createOrderConfigTree, deleteRuleCascade } from "./devHelpers";
import { openRuleFromHub, toolbar } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// Three halves of FieldMappingDialog that a fixture DOM cannot reach: the `ref` source, the `node`
// source, and the Apply-BLOCKED path. All three are authored in a browser and read back off the
// persisted row.
//
//   * `ref` ("Link to a record", FieldMappingDialog.tsx:40 gating + :396-412 editor, serialised by
//     fieldMapping.ts:158). The riskiest of the three because the engine turns this entry into the
//     lookup bind on every row the action writes (FieldMappingParser.cs "ref" branch →
//     Guid.TryParse or throw): a mis-serialised `ref` 400s EVERY write the rule performs, with no
//     author-time warning at all.
//   * `node` ("From related record", :365-395). The node→table→columns chain runs entirely off
//     live metadata: the related-node list is filtered to SAVED single-cardinality nodes and its
//     dependent ColumnPicker is `compatibleWith` the target column's kind, both computed from real
//     attributeTypes on two different tables.
//   * the Apply-blocked path (:591-600 `apply` refuses while validateRows is non-empty, :462
//     ErrorSummary, :180-190, rowFieldErrors :93-146, FooterStatus "N problems to fix" :494-498).
//     A dialog that applies an invalid mapping anyway pushes the failure from authoring time out to
//     EXECUTION time, the same family as the blank-node-filter behaviour pinned in
//     nodeFilterUi.e2e:210-234.
//
// ORACLE, deliberately not "Ready to apply": the persisted `asx_fieldmapping` JSON read back off
// the row, then the SAME mapping re-loaded out of the dialog after a hub reload, then
// asx_ValidateRule's verdict on the saved rule. A test that stopped at the footer text would pass
// against a dialog that serialises `ref` down the `node` branch: the two shapes differ by one
// key, and only the persisted payload tells them apart. Execution stays covered by
// ruleBehaviorWrite; this file owns the browser→row half.

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

// One entry of the asx_fieldmapping array, the engine contract parsed by
// Core/Actions/FieldMappingParser.cs. Only the keys these cases assert are named.
interface MappingEntry {
  target?: string; source?: string; value?: unknown; column?: string; node?: string;
}

// Fluent portals every DialogSurface to document.body; filtering on the title text keeps this
// correct if a second dialog is ever open at the same time (see aggregateFiltersUi's note).
const mapDialog = (frame: FrameLocator) =>
  frame.getByRole("dialog").filter({ hasText: "Map columns" }).first();

// GUIDs travel REST -> editor -> REST and nothing promises the casing survives identical.
const sameGuid = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();

// A Lookup (type 2) config node. devHelpers only builds Root (createZzRootConfig) and ChildTable
// (addChildNode) nodes, and the `node` source needs a SINGLE-cardinality related node: a child collection is
// filtered out of the related-node list by isSingleCardinality. Field set copied from
// test-dev/ruleBehavior/authoring.ensureTableConfig's `customer` node: asx_lookuptargetidattribute
// is required on every LookupTable node and is the TARGET table's own primary-id attribute.
// The id needs no bookkeeping: createZzRootConfig's cleanup walks descendants depth-first.
async function addLookupNode(
  parentId: string,
  opts: { name: string; table: string; lookupColumn: string; targetIdAttribute: string },
): Promise<string> {
  const api = createDevApi();
  return api.createRecord(ENTITY_SET.tableConfig, {
    asx_name: opts.name.startsWith("ZZ_RB_") ? opts.name : `ZZ_RB_${opts.name}`,
    asx_tablelogicalname: opts.table,
    asx_tableconfigtype: 2 /* LookupTable */,
    asx_lookupcolumnlogicalname: opts.lookupColumn,
    asx_lookuptargetidattribute: opts.targetIdAttribute,
    [`${BIND_NAV.tableConfigParent}@odata.bind`]: `/${ENTITY_SET.tableConfig}(${parentId})`,
  });
}

const rand = () => Math.random().toString(36).slice(2, 8);

// A Draft rule that already HAS a condition (authored by REST so the browser only authors the
// action) and no actions. The condition exists purely so the closing asx_ValidateRule call has
// something to validate: a rule with no conditions is rejected with STRUCT_NO_CONDITIONS
// however good the mapping is.
async function skeleton(name: string, rootId: string) {
  return authorRule({
    name: `ZZ_RB_${name}_${rand()}_rule`,
    rootNodeId: rootId,
    triggers: "3", // Manual only: this rule must never fire against the shared org
    conditions: [{
      nodeId: rootId, conditionType: 1, column: "sample_ordertotal",
      operator: 4 /* GreaterThanOrEqual */, valueSource: 1, literal: "0",
    }],
    actions: [],
    publish: false, requireValid: false, // no action yet, so not valid until the UI adds one
  });
}

// Add a CreateRecord action on `targetTable` and open its Map columns dialog. CreateRecord (not
// UpdateRecord) because its mapping columns are checked with requireCreatable
// (MetadataChecks.CheckMappingColumns), which is the stricter of the two gates.
async function openCreateRecordMapping(
  page: Page, appId: string, ruleName: string, targetTable: string,
): Promise<FrameLocator> {
  const frame = await openRuleFromHub(page, appId, ruleName);
  await frame.getByRole("button", { name: "+ Add action" }).click();
  await frame.getByRole("button", { name: /^Edit action 1/ }).click();

  const type = frame.getByRole("combobox", { name: "Action type" });
  await type.click();
  await frame.getByRole("option", { name: CHOICE.actionType.createRecord, exact: true }).click();

  // TablePicker: a freeform Combobox over LIVE table metadata, not a fixed list.
  const table = frame.getByRole("combobox", { name: "Target table" });
  await table.click();
  await table.pressSequentially(targetTable, { delay: 30 });
  await frame.getByRole("option", { name: new RegExp(`\\(${targetTable}\\)`) }).click();

  await frame.getByRole("button", { name: "Edit columns…" }).click();
  return frame;
}

// Add a mapping row and bind its TARGET column. `index` is 1-based: the ColumnPicker's aria-label
// is `Column ${index}`, and exact:true is load-bearing: role-name matching is substring and
// case-insensitive, so a bare "Column 2" also matches the sibling "Source for column 2" while the
// row has no target yet.
async function addMappingRow(
  frame: FrameLocator, index: number, query: string, option: RegExp,
): Promise<void> {
  await mapDialog(frame).getByRole("button", { name: "Add column" }).first().click();
  const col = frame.getByRole("combobox", { name: `Column ${index}`, exact: true });
  await col.click();
  await col.pressSequentially(query, { delay: 30 });
  await frame.getByRole("option", { name: option }).click();
}

// Only the SELECTED row's detail pane is mounted (master-detail), so exactly one "Source for …"
// dropdown exists at a time and the prefix match is unambiguous.
async function pickSource(frame: FrameLocator, label: string): Promise<void> {
  const source = frame.getByRole("combobox", { name: /^Source for/ });
  await source.click();
  await frame.getByRole("option", { name: label, exact: true }).click();
}

// Re-open the saved rule and get back into the mapping dialog with the first row selected.
// FieldMappingDialog resets selectedKey to null on open (:528), so the row must be clicked before
// the detail pane mounts any editor at all.
async function reopenMapping(page: Page, appId: string, ruleName: string): Promise<FrameLocator> {
  const frame = await openRuleFromHub(page, appId, ruleName);
  await frame.getByRole("button", { name: /^Edit action 1/ }).click();
  await frame.getByRole("button", { name: "Edit columns…" }).click();
  await frame.getByTestId("fm-list-item").first().click();
  return frame;
}

test("the ref source links the created row to a config node and persists { source: ref, node }", async ({ page }) => {
  const appId = await resolveAppId();
  const CFG = "ZZ_RB_mapsrc_ref";
  const cfg = await createOrderConfigTree("mapsrc_ref");
  const rule = await skeleton("mapsrc_ref", cfg.rootId);
  try {
    const frame = await openCreateRecordMapping(page, appId, rule.ruleName, "sample_orderline");

    // sample_orderline.sample_orderid is the child's Lookup back to the order. `ref` is offered
    // ONLY because kindOf(target) is "lookup" (FieldMappingDialog.tsx:40), and that kind is read
    // off the live attributeType, so reaching this option at all proves the gating ran on real metadata.
    await addMappingRow(frame, 1, "sample_orderid", /\(sample_orderid\)/);
    await pickSource(frame, "Link to a record");

    const record = frame.getByRole("combobox", { name: /^Record for/ });
    await record.click();
    // The child COLLECTION must not be offered (:409 filters on isSingleCardinality): a
    // many-cardinality node cannot name one record to link to, so offering it would author a
    // mapping the engine can only fail on at runtime.
    await expect(frame.getByRole("option", { name: /_line$/ })).toHaveCount(0);
    // The root renders with the " (this record)" suffix (:400,405), the copy that tells the
    // author this links the new line back to the row that triggered the rule.
    await frame.getByRole("option", { name: `${CFG} (this record)`, exact: true }).click();

    await expect(mapDialog(frame).getByText("Ready to apply")).toBeVisible();
    await mapDialog(frame).getByRole("button", { name: "Apply", exact: true }).click();

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const action = await actionOf(rule.ruleId);
    expect(action.asx_actiontype).toBe(5); // CreateRecord
    expect(action.asx_targettable).toBe("sample_orderline");

    const mapping = JSON.parse(String(action.asx_fieldmapping)) as MappingEntry[];
    expect(mapping.length).toBe(1);
    expect(mapping[0].target).toBe("sample_orderid");
    expect(mapping[0].source).toBe("ref");
    expect(sameGuid(mapping[0].node, cfg.rootId), "the ref entry must name the ROOT config node — FieldMappingParser rejects anything that is not a GUID, and a wrong node makes every write bind to the wrong record").toBe(true);
    // The exact key set, not just the values: `ref` and `node` differ by one key
    // (fieldMapping.ts:158 vs :159), and a fall-through to the node branch would emit
    // `source: "node", column: null`, still valid JSON, still "Ready to apply", and rejected by
    // the engine on every row the action writes.
    expect(Object.keys(mapping[0]).sort()).toEqual(["node", "source", "target"]);

    // ROUND TRIP: parseFieldMapping (:102-105) has to recognise `ref` and re-seed the Record
    // dropdown, otherwise the row re-opens as an unknown/blank source and the next edit silently
    // rewrites the mapping the author never touched.
    const reloaded = await reopenMapping(page, appId, rule.ruleName);
    await expect(reloaded.getByRole("combobox", { name: /^Source for/ })).toContainText("Link to a record");
    await expect(reloaded.getByRole("combobox", { name: /^Record for/ })).toContainText(`${CFG} (this record)`);

    // Close the dialog before touching the toolbar: the Fluent modal traps pointer events.
    await mapDialog(reloaded).getByRole("button", { name: "Cancel", exact: true }).click();

    // Last, so a failure here is unambiguous: the payload persisted and round-tripped, and it is
    // the SERVER validator that rejected it.
    await toolbar(reloaded).getByRole("button", { name: /^(Validate|Save & validate)$/ }).click();
    await expect(reloaded.getByText("Validation passed. The rule is valid.")).toBeVisible({ timeout: 30_000 });
  } finally {
    await deleteRuleCascade(rule.ruleId); // the UI-created action isn't tracked by the fixture
    await rule.cleanup().catch(() => {});
    await cfg.cleanup();
  }
});

test("the node source copies a related record's column and persists { source: node, node, column }", async ({ page }) => {
  const appId = await resolveAppId();
  const CUSTOMER = "ZZ_RB_mapsrc_node_customer";
  const cfg = await createOrderConfigTree("mapsrc_node");
  // Order -> Customer (Lookup). The line child that createOrderConfigTree already made is the
  // negative half of the related-node assertion below.
  const customerId = await addLookupNode(cfg.rootId, {
    name: CUSTOMER, table: "sample_customer",
    lookupColumn: "sample_customerid", targetIdAttribute: "sample_customerid",
  });
  await configsVisible([cfg.rootId, cfg.childId, customerId]);
  const rule = await skeleton("mapsrc_node", cfg.rootId);
  try {
    const frame = await openCreateRecordMapping(page, appId, rule.ruleName, "sample_orderline");

    // The canonical use case: "copy the customer's credit limit onto the new line".
    await addMappingRow(frame, 1, "sample_lineamount", /\(sample_lineamount\)/);
    await pickSource(frame, "From related record");

    const node = frame.getByRole("combobox", { name: /^Related node for/ });
    await node.click();
    // Same single-cardinality gate as `ref` (:377): a collection has no single row to read from.
    await expect(frame.getByRole("option", { name: /_line$/ })).toHaveCount(0);
    await frame.getByRole("option", { name: CUSTOMER, exact: true }).click();

    // The dependent ColumnPicker now points at the RELATED node's table (:387,
    // tableConfigs[row.node].tableLogicalName), filtered compatibleWith the target's kind:
    // sample_customer's Money columns for a Money target. A picker still pointed at the rule's
    // own table would list sample_order columns and this option would not exist.
    const column = frame.getByRole("combobox", { name: /^Column for/ });
    await column.click();
    await column.pressSequentially("creditlimit", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_creditlimit\)/ }).click();

    await expect(mapDialog(frame).getByText("Ready to apply")).toBeVisible();
    await mapDialog(frame).getByRole("button", { name: "Apply", exact: true }).click();

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const mapping = JSON.parse(String((await actionOf(rule.ruleId)).asx_fieldmapping)) as MappingEntry[];
    expect(mapping.length).toBe(1);
    expect(mapping[0].target).toBe("sample_lineamount");
    expect(mapping[0].source).toBe("node");
    expect(mapping[0].column).toBe("sample_creditlimit");
    expect(sameGuid(mapping[0].node, customerId), "the node entry must name the LOOKUP node the author picked — the engine resolves the source column against that node's table, so a wrong id reads a different table entirely").toBe(true);
    // `node` carries BOTH node and column; dropping either is what turns a working mapping into
    // one the engine rejects (FieldMappingParser's "node" branch reads both).
    expect(Object.keys(mapping[0]).sort()).toEqual(["column", "node", "source", "target"]);

    const reloaded = await reopenMapping(page, appId, rule.ruleName);
    await expect(reloaded.getByRole("combobox", { name: /^Source for/ })).toContainText("From related record");
    await expect(reloaded.getByRole("combobox", { name: /^Related node for/ })).toContainText(CUSTOMER);
    // The ColumnPicker is a freeform Combobox (an <input>), not a Dropdown button: its restored
    // selection reads as the input's value, `${displayName} (${logicalName})`.
    await expect(reloaded.getByRole("combobox", { name: /^Column for/ })).toHaveValue(/\(sample_creditlimit\)/);

    await mapDialog(reloaded).getByRole("button", { name: "Cancel", exact: true }).click();
    await toolbar(reloaded).getByRole("button", { name: /^(Validate|Save & validate)$/ }).click();
    await expect(reloaded.getByText("Validation passed. The rule is valid.")).toBeVisible({ timeout: 30_000 });
  } finally {
    await deleteRuleCascade(rule.ruleId);
    await rule.cleanup().catch(() => {});
    await cfg.cleanup(); // walks descendants, reclaiming the lookup node too
  }
});

test("an incomplete mapping row blocks Apply with an inline error, and completing it unblocks Apply", async ({ page }) => {
  const appId = await resolveAppId();
  const cfg = await createOrderConfigTree("mapsrc_val");
  const rule = await skeleton("mapsrc_val", cfg.rootId);
  try {
    const frame = await openCreateRecordMapping(page, appId, rule.ruleName, "sample_orderline");

    // Row 1 is complete, so the refusal below can only come from row 2: a dialog that refused
    // everything would pass a single-row version of this test for the wrong reason.
    await addMappingRow(frame, 1, "sample_name", /\(sample_name\)/);
    await frame.getByRole("textbox", { name: /^Value for/ }).fill("ZZ_RB mapping row");

    // Row 2: target chosen, source switched to "From this record", source column left BLANK.
    // rowFieldErrors (:98) flags exactly this as `sourceColumn`.
    await addMappingRow(frame, 2, "notes", /\(sample_notes\)/);
    await pickSource(frame, "From this record");

    // Before the first Apply, showErrors is gated on hasSubmitted (:589) so the author mid-edit
    // is not scolded: no inline error yet…
    await expect(mapDialog(frame).getByText("Choose a source column.", { exact: true })).toHaveCount(0);
    // …and the footer still reads "Ready to apply" even though this mapping is NOT appliable
    // (FooterStatus's kind is `showErrors && errors.length ? "invalid" : "valid"`, :620). Pinned
    // deliberately: "Ready to apply" is visible over an INVALID mapping, so that text can never be
    // evidence that a mapping is valid, which is why every case in this file asserts on the
    // persisted payload instead.
    await expect(mapDialog(frame).getByText("Ready to apply")).toBeVisible();

    await mapDialog(frame).getByRole("button", { name: "Apply", exact: true }).click();

    // THE assertion the blocked path is about: apply() set hasSubmitted and RETURNED without calling
    // onApply (:591-600). The dialog is still open, so nothing was written back to the action.
    await expect(mapDialog(frame), "Apply must refuse an incomplete mapping; a dialog that closed here would have written a mapping the engine can only fail on at execution").toBeVisible();
    // FooterStatus's invalid branch (:494-498), singular, because exactly one row is at fault.
    await expect(mapDialog(frame).getByText("1 problem to fix")).toBeVisible();
    // ErrorSummary's Callout title + its one li, straight out of validateRows (fieldMapping.ts:180).
    // The li is labelled by the TARGET column, which is how an author finds the row in the rail.
    await expect(mapDialog(frame).getByText("1 thing to fix before applying")).toBeVisible();
    await expect(mapDialog(frame).getByText("sample_notes: choose a source column.")).toBeVisible();
    // …and the InlineError on the offending control itself (:69-76). exact:true keeps this off
    // the summary li above, whose text contains the same sentence.
    await expect(mapDialog(frame).getByText("Choose a source column.", { exact: true })).toBeVisible();

    // Complete the row. Errors re-evaluate live once hasSubmitted is set, so the footer must flip
    // without a second Apply.
    const from = frame.getByRole("combobox", { name: /^Value for/ });
    await from.click();
    await from.pressSequentially("approval", { delay: 30 });
    await frame.getByRole("option", { name: /\(sample_approvalnotes\)/ }).click();
    await expect(mapDialog(frame).getByText("Ready to apply")).toBeVisible();

    await mapDialog(frame).getByRole("button", { name: "Apply", exact: true }).click();
    await expect(mapDialog(frame), "with every row complete Apply must close the dialog").toBeHidden();

    await toolbar(frame).getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    // BOTH rows persisted, in list order. This is the half that proves the refusal cost nothing:
    // the valid row typed before the block is still there, unmodified.
    const mapping = JSON.parse(String((await actionOf(rule.ruleId)).asx_fieldmapping)) as MappingEntry[];
    expect(mapping).toEqual([
      { target: "sample_name", source: "literal", value: "ZZ_RB mapping row" },
      { target: "sample_notes", source: "root", column: "sample_approvalnotes" },
    ]);
  } finally {
    await deleteRuleCascade(rule.ruleId);
    await rule.cleanup().catch(() => {});
    await cfg.cleanup();
  }
});
