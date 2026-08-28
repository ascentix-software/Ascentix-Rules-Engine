import { test, expect } from "@playwright/test";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { createDevApi } from "../test-dev/devApi";
import { ENTITY_SET, LOOKUP } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId, createOrderConfigTree, deleteRuleCascade } from "./devHelpers";
import { openRuleFromHub, toolbar } from "./editorHarness";
import { CHOICE } from "./liveLabels";

// The Aggregates chip row and AggregateFilterDialog, driven in a real browser. Both surfaces only
// exist once an aggregate has been inserted, and both write payloads the engine parses:
//   * the Aggregates CHIP ROW (valueExpressions.tsx:300-351, data-testid="agg-section") is the
//     only way to CHANGE an aggregate once inserted, and its rewrite engine is string surgery on
//     the live textarea value (rewriteAggregate :154-184, findAggregateSpan :89-116).
//   * AggregateFilterDialog ("Only rows where…") writes TWO things that must agree: a
//     ` filter:<key>` clause inside the aggregate call (insertFilterToken,
//     valueExpressions.tsx:118-123) and a sidecar `filters` map serialised into asx_fieldmapping
//     (fieldMapping.ts:144-148). If they disagree, Core/Actions/FieldMappingParser.cs:129-149
//     throws and EVERY write the action performs fails. The C# parser is unit-tested on its own
//     (AggregateFilterParserTests). These cases produce the payload from the product instead.
//
// WHY IT HAS TO GO THROUGH THE MAPPING DIALOG. ConditionInspector.tsx:301-302 mounts
// MathExprEditor WITHOUT `filters`/`onFiltersChange`, so `showFilters` (valueExpressions.tsx:203)
// is false and the chip section never renders on the Expression-condition path. That is
// deliberate and documented at valueExpressions.tsx:189-193. It is not a defect. The chip row
// and the dialog are reachable ONLY from FieldMappingDialog.tsx:420-428, the `mathexpr` source
// row of a write-action column mapping, which is the route both cases take. Getting there depends
// on live Dataverse column metadata (see openCalculationMapping below), which a fixture DOM does
// not supply.
//
// ORACLE: the persisted `asx_fieldmapping` JSON (the engine contract, so a mis-serialised entry
// is a silent production failure) plus the same mapping read back OUT of the dialog after a hub
// reload, plus asx_ValidateRule's verdict on the saved rule. The reload half carries the most:
// it is the only assertion that a filtered aggregate survives persist-and-re-load through the
// product. Execution stays covered by ruleBehaviorWrite / ruleBehaviorAggregate.

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
    `&$select=asx_actiontype,asx_fieldmapping,${LOOKUP.actionTargetNode}`,
  );
  return r.entities[0] as Record<string, unknown>;
};

// The shape asx_fieldmapping carries for a Calculation source. `filters` is the raw editor
// NodeFilterGroupModel tree (model/nodeFilter.ts), keyed by the `filter:<key>` clause in the
// expression, NOT the asx_nodefiltergroup/criterion rows a CONDITION filter writes, which is why
// its operator is the numeric ComparisonOperator code and not a FetchXML token.
interface FilterLeaf { kind?: string; column?: string; operator?: number; valueSource?: number; value?: string }
interface FilterGroup { kind?: string; op?: string; rules?: FilterLeaf[] }
interface MappingEntry {
  target?: string; source?: string; expression?: string; filters?: Record<string, FilterGroup>;
}

// See the note in aggregateFunctionsUi: the MathExprEditor Textarea has no accessible label, and
// "+ - * / and ( )" is the tail that belongs to it alone (TemplateEditor's placeholder also
// contains "use Insert field").
const exprBox = (frame: FrameLocator) => frame.getByPlaceholder("+ - * / and ( )");

// Fluent portals every DialogSurface to document.body, so the mapping dialog and the aggregate
// filter dialog are DOM SIBLINGS while both are open. A bare frame.getByRole("dialog") is then a
// strict-mode violation. Filtering on the title text disambiguates; .first()/.last() make the
// locators correct even if a future Fluent version stops portalling and nests them instead.
const mapDialog = (frame: FrameLocator) =>
  frame.getByRole("dialog").filter({ hasText: "Map columns" }).first();
const aggDialog = (frame: FrameLocator) =>
  frame.getByRole("dialog").filter({ hasText: "Filter this aggregate" }).last();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Case-insensitive: the config-node GUID travels REST -> editor -> REST and nothing guarantees
// the casing survives identical.
const exactly = (s: string) => new RegExp(`^${escapeRe(s)}$`, "i");

const rand = () => Math.random().toString(36).slice(2, 8);

// Skeleton for both cases: a two-level config tree plus a Draft rule that already HAS a condition
// (authored by REST so the browser only has to author the action) and no actions. The condition
// exists purely so asx_ValidateRule has something to validate: a rule with none is rejected with
// STRUCT_NO_CONDITIONS regardless of how good the mapping is.
async function skeleton(name: string) {
  const cfg = await createOrderConfigTree(name);
  const rule = await authorRule({
    name: `ZZ_RB_${name}_${rand()}_rule`,
    rootNodeId: cfg.rootId,
    triggers: "3", // Manual only: this rule must never fire against the shared org
    conditions: [{
      nodeId: cfg.rootId, conditionType: 1, column: "sample_ordertotal",
      operator: 4 /* GreaterThanOrEqual */, valueSource: 1, literal: "0",
    }],
    actions: [],
    publish: false, requireValid: false, // no action yet, so not valid until the UI adds one
  });
  return { cfg, rule };
}

// Add an UpdateRecord action targeting the ROOT node, open Map columns, add one row bound to the
// numeric sample_ordertotal, and switch its source to Calculation. `mathexpr` is only OFFERED for
// a number-kind target (FieldMappingDialog.tsx:41), and that kind comes from live column metadata
// (kindOf, :558-562), so simply reaching this point proves the gating ran against real metadata.
async function openCalculationMapping(page: Page, appId: string, ruleName: string, cfgName: string) {
  const frame = await openRuleFromHub(page, appId, ruleName);
  await frame.getByRole("button", { name: "+ Add action" }).click();
  await frame.getByRole("button", { name: /^Edit action 1/ }).click();

  const type = frame.getByRole("combobox", { name: "Action type" });
  await type.click();
  await frame.getByRole("option", { name: CHOICE.actionType.updateRecord, exact: true }).click();

  // Only single-cardinality nodes are offered, so the root is the sole choice; naming it exactly
  // keeps this immune to a leaked fixture whose name happens to share a prefix.
  await frame.getByRole("combobox", { name: "Target node" }).click();
  await frame.getByRole("option", { name: cfgName, exact: true }).click();

  await frame.getByRole("button", { name: "Edit columns…" }).click();
  const dlg = mapDialog(frame);
  await dlg.getByRole("button", { name: "Add column" }).first().click();

  // exact: the sibling Source dropdown is "Source for column 1" and role-name matching is
  // substring by default.
  const col = frame.getByRole("combobox", { name: "Column 1", exact: true });
  await col.click();
  await col.pressSequentially("ordertotal", { delay: 30 });
  await frame.getByRole("option", { name: /\(sample_ordertotal\)/ }).click();

  const source = frame.getByRole("combobox", { name: /^Source for/ });
  await source.click();
  await frame.getByRole("option", { name: "Calculation", exact: true }).click();
  return frame;
}

const LINE_AMOUNT = /Line [Aa]mount|sample_lineamount/;

// ---------------------------------------------------------------------------------------------
// WHY THIS FILE DOES NOT USE editorHarness.pickFromMenu
// ---------------------------------------------------------------------------------------------
// aggregateFunctionsUi drives the very same InsertAggregateMenu with pickFromMenu and passes.
// Here it timed out. The labels are NOT the difference. Measured against DEV, the
// menu offers exactly what it should:
//   level 1  Sum · Average · Min · Max · Count
//   level 2  ZZ_RB_<cfg>_line                       (the collection node, correct)
//   level 3  Exchange Rate · Import Sequence Number · Line Amount · Line Amount (Base) ·
//            Quantity · Time Zone Rule Version Number · UTC Conversion Time Zone Code ·
//            Version Number                          (the numeric columns, correct)
// and clicking "Line Amount" emits exactly `sum(node:<child>.sample_lineamount)`.
//
// The difference is that this menu is opened from inside a MODAL dialog, and two things follow
// from that:
//
//  1. HISTORY (fixed). Fluent used to portal each MenuPopover into its own
//     body-level `div.fui-FluentProvider`; the modal's tabster modalizer stamped
//     aria-hidden="true" on every one of those but the dialog's own and never lifted it, so
//     `[role="menuitem"]` found 6 items where `getByRole("menuitem")` found 5 and pickFromMenu's
//     role-based waitFor could never resolve. That was a real product defect (screen-reader users
//     could not author an aggregate from this dialog at all) and it is fixed: the popovers now
//     mount inside the DialogSurface (InsertFieldMenu.tsx `InsertMenuMountNode`,
//     FieldMappingDialog.tsx `fm-menu-mount`), pinned live by e2e/menuA11yInDialog.e2e.spec.ts,
//     which asserts the two locator strategies agree again.
//
//  2. STILL TRUE. Fluent re-positions the level-1 popover after it opens (its popper reports
//     data-popper-is-intersecting inside the dialog), which can slide the trigger out from under a
//     stationary mouse and collapse an already-open submenu. pickFromMenu hovers each level once
//     and never re-hovers, so it is still the wrong driver here. `openLevel` below re-opens each
//     level on demand, and that is why this file keeps its own helpers.
//
// The attribute-based locator is kept rather than reverted to a role-based one: it is strictly
// less able to hide an a11y regression behind a green run here, and menuA11yInDialog is where the
// accessibility tree is asserted on purpose.
// ---------------------------------------------------------------------------------------------

// Located by the ATTRIBUTE rather than the role (see 1. above). `.first()` mirrors pickFromMenu:
// an ancestor level may still render an item whose text also matches.
const menuItem = (frame: FrameLocator, name: RegExp): Locator =>
  frame.locator('[role="menuitem"]').filter({ hasText: name }).first();

// Fluent re-positions the level-1 popover after it opens (its popper reports
// data-popper-is-intersecting inside the dialog), which can slide the trigger out from under the
// stationary mouse and collapse an already-open submenu. So each level is re-opened on demand by
// re-hovering its parent rather than assumed to stay open.
async function openLevel(frame: FrameLocator, path: RegExp[], i: number): Promise<Locator> {
  const item = menuItem(frame, path[i]);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await item.isVisible().catch(() => false)) return item;
    if (i === 0) await frame.getByRole("button", { name: "Insert aggregate", exact: true }).click();
    else await (await openLevel(frame, path, i - 1)).hover();
    await item.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  }
  await item.waitFor({ state: "visible", timeout: 5_000 }); // out of retries: fail with the real error
  return item;
}

// "Insert aggregate ▸ <fn> ▸ <collection> ▸ <column>", hovering every level and clicking the leaf
// This is the same contract as pickFromMenu, only with attribute-based locators.
async function pickAggregate(frame: FrameLocator, path: RegExp[]): Promise<void> {
  for (let i = 0; i < path.length - 1; i++) await (await openLevel(frame, path, i)).hover();
  await (await openLevel(frame, path, path.length - 1)).click();
}

test("a filtered aggregate authored in the Map columns dialog persists expression + filters and survives a reload", async ({ page }) => {
  const appId = await resolveAppId();
  const CFG = "ZZ_RB_aggflt_a";
  const { cfg, rule } = await skeleton("aggflt_a");
  try {
    const frame = await openCalculationMapping(page, appId, rule.ruleName, CFG);
    const ta = exprBox(frame);

    await pickAggregate(frame, [/^Sum$/, /_line$/, LINE_AMOUNT]);
    const BARE = `sum(node:${cfg.childId}.sample_lineamount)`;
    await expect(ta).toHaveValue(exactly(BARE));

    // (1) The chip row renders HERE and only here: FieldMappingDialog passes filters/
    // onFiltersChange (:425-428) so showFilters is true. One aggregate, one chip row.
    await expect(frame.getByTestId("agg-section")).toBeVisible();
    await expect(frame.getByTestId("agg-chip-row")).toHaveCount(1);

    // The unfiltered affordance (valueExpressions.tsx:276), the copy an author reads to know the
    // aggregate counts every related row.
    const filterChip = frame.getByRole("button", { name: /Only rows where.*No filter/ });
    await expect(filterChip).toBeVisible();

    // (2) Author a criterion. AggregateFilterDialog hosts a SINGLE NodeFilterBuilder already
    // scoped to the aggregate's own table (sample_orderline). Unlike the condition's
    // NodeFilterDialog there is no target-node picker and no "Add filter", because the aggregate
    // call already fixes the node. The working copy is seeded with emptyGroup(), i.e. one blank
    // leaf, so the row to fill is the one already on screen.
    await filterChip.click();
    const dlg = aggDialog(frame);
    await expect(dlg).toContainText("Only records matching this filter are included in the aggregate.");
    await expect(dlg.getByRole("combobox", { name: "Filter column" })).toHaveCount(1);

    const col = dlg.getByRole("combobox", { name: "Filter column" });
    await col.click();
    await col.pressSequentially("line amount", { delay: 30 });
    // Options render in their own portal, so they are located frame-wide, not through the dialog.
    await frame.getByRole("option", { name: /\(sample_lineamount\)/ }).click();

    const op = dlg.getByRole("combobox", { name: "Filter operator" });
    await op.click();
    // NodeFilterBuilder uses its OWN operator labels (OP_LABEL), "Greater than", not the global
    // choice's "Greater Than".
    await frame.getByRole("option", { name: "Greater than", exact: true }).click();

    await dlg.getByRole("textbox", { name: "Filter value" }).fill("100");
    await dlg.getByRole("button", { name: "Apply", exact: true }).click();

    // (3) The chip now reports a count instead of "No filter" (valueExpressions.tsx:277) …
    await expect(frame.getByRole("button", { name: /Only rows where.*1 condition/ })).toBeVisible();
    // … and applyFilter allocated key f1 and spliced ` filter:f1` INSIDE the closing paren.
    // The clause living inside the call is what makes it belong to this aggregate rather than to
    // the expression as a whole: findAggregateSpan addresses aggregates by ordinal.
    const FILTERED = `sum(node:${cfg.childId}.sample_lineamount filter:f1)`;
    await expect(ta).toHaveValue(exactly(FILTERED));

    await expect(mapDialog(frame).getByText("Ready to apply")).toBeVisible();
    await mapDialog(frame).getByRole("button", { name: "Apply", exact: true }).click();

    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const action = await actionOf(rule.ruleId);
    expect(action.asx_actiontype).toBe(6); // UpdateRecord
    expect(action[LOOKUP.actionTargetNode]).toBe(cfg.rootId);

    const mapping = JSON.parse(String(action.asx_fieldmapping)) as MappingEntry[];
    expect(mapping.length).toBe(1);
    const [entry] = mapping;
    expect(entry.target).toBe("sample_ordertotal");
    expect(entry.source).toBe("mathexpr");
    expect(String(entry.expression).toLowerCase()).toBe(FILTERED.toLowerCase());

    // The sidecar map. Its key MUST be the same `f1` the expression names: a mismatch here is
    // exactly what FieldMappingParser.cs:129-149 throws on, and it would be invisible to any
    // assertion that only looked at the expression string.
    expect(Object.keys(entry.filters ?? {}), "the filters sidecar must carry exactly the key the expression's filter: clause names").toEqual(["f1"]);
    const f1 = entry.filters!.f1;
    expect(f1.kind).toBe("group");
    expect(f1.op).toBe("and");
    expect(f1.rules?.length).toBe(1);
    // operator 3 = GreaterThan on the numeric ComparisonOperator enum. A node-filter CRITERION row
    // stores the FetchXML token "gt" instead (save/diff.ts operatorToFetchOp). This payload is
    // JSON inside asx_fieldmapping, not a criterion row, so the numeric code is the right answer
    // and "gt" here would mean the wrong serialiser ran.
    expect(f1.rules?.[0]).toMatchObject({
      kind: "rule", column: "sample_lineamount", operator: 3, valueSource: 1, value: "100",
    });

    // (4) ROUND-TRIP: the first time this payload has ever been persisted AND re-loaded through
    // the product. parseFieldMapping (fieldMapping.ts:110-115) has to hand `filters` back, and the
    // pruning effect (valueExpressions.tsx:237-246) must NOT wipe f1 on mount: it scans the raw
    // expression text for filter:<key>, so a version that drove pruning off parsed refs would drop
    // the whole map here and the chip would silently read "No filter" again.
    const reloaded = await openRuleFromHub(page, appId, rule.ruleName);
    await reloaded.getByRole("button", { name: /^Edit action 1/ }).click();
    await reloaded.getByRole("button", { name: "Edit columns…" }).click();
    // The dialog re-opens with NO row selected (FieldMappingDialog resets selectedKey on open),
    // so the row has to be chosen before the detail pane mounts the editor. The first button in
    // fm-list is the row; "Add column" is the last.
    await reloaded.getByTestId("fm-list").getByRole("button").first().click();
    await expect(exprBox(reloaded)).toHaveValue(exactly(FILTERED));
    await expect(reloaded.getByRole("button", { name: /Only rows where.*1 condition/ })).toBeVisible();

    // Close the dialog before touching the toolbar: the Fluent modal traps pointer events.
    await mapDialog(reloaded).getByRole("button", { name: "Cancel", exact: true }).click();

    // Last, because a failure here is then unambiguous: everything persisted and round-tripped,
    // and the SERVER validator is what rejected the filtered-aggregate mapping.
    await toolbar(reloaded).getByRole("button", { name: "Validate" }).click();
    await expect(reloaded.getByText("Validation passed. The rule is valid.")).toBeVisible({ timeout: 30_000 });
  } finally {
    await deleteRuleCascade(rule.ruleId); // the UI-created action isn't tracked by the fixture
    await rule.cleanup().catch(() => {});
    await cfg.cleanup();
  }
});

test("the Aggregates chip row rewrites the aggregate in place, including across the count arity boundary", async ({ page }) => {
  const appId = await resolveAppId();
  const CFG = "ZZ_RB_aggflt_b";
  const { cfg, rule } = await skeleton("aggflt_b");
  try {
    const frame = await openCalculationMapping(page, appId, rule.ruleName, CFG);
    const ta = exprBox(frame);

    await pickAggregate(frame, [/^Sum$/, /_line$/, LINE_AMOUNT]);
    await expect(ta).toHaveValue(exactly(`sum(node:${cfg.childId}.sample_lineamount)`));

    // The chip dropdowns are Fluent Dropdowns carrying explicit aria-labels
    // (valueExpressions.tsx:315/330/336). Their option lists come from useColumns over LIVE
    // metadata, filtered to columnKind === "number" (:218-224), the same filter the insert menu
    // uses, but reached through a completely different code path.
    const fn = frame.getByRole("combobox", { name: "Aggregate function" });

    // sum -> avg: a plain in-place identifier swap; the node and column must be untouched.
    await fn.click();
    await frame.getByRole("option", { name: "avg", exact: true }).click();
    await expect(ta).toHaveValue(exactly(`avg(node:${cfg.childId}.sample_lineamount)`));

    // avg -> count CROSSES THE ARITY BOUNDARY (rewriteAggregate :176-182): count takes no column,
    // so the rewrite must DROP it. Leaving "count(node:<id>.<col>)" behind is rejected by
    // mathExpr.ts:50, the expression stops parsing, every chip goes disabled, and the author is
    // stuck with a Calculation they can no longer edit.
    await fn.click();
    await frame.getByRole("option", { name: "count", exact: true }).click();
    await expect(ta).toHaveValue(exactly(`count(node:${cfg.childId})`));
    // The column dropdown is hidden for count (valueExpressions.tsx:335): there is nothing to pick.
    await expect(frame.getByRole("combobox", { name: "Aggregate column" })).toHaveCount(0);

    // count -> max crosses back. rewriteAggregate no-ops rather than emit an invalid
    // "max(node:<id>)", so the chip has to SUPPLY a column itself (:311-322, taking the first
    // numeric column on the collection). Which one that is depends on live metadata ordering, so
    // the assertion pins the invariant that matters: the node survives, the function became max,
    // and SOME column was supplied.
    //
    // It is emphatically not one of the two custom columns. `availableCols` is aggColumnsByNode
    // (valueExpressions.tsx:218-224), every column of sample_orderline whose columnKind is
    // "number", metadata order, system columns included. Measured against DEV, the list
    // is: Exchange Rate, Import Sequence Number, Line Amount, Line Amount (Base), Quantity, Time
    // Zone Rule Version Number, UTC Conversion Time Zone Code, Version Number, so [0] is
    // `exchangerate`, and that is what the chip emits. Pinning `(sample_lineamount|sample_quantity)`
    // here asserted a column ordering nothing in the product promises. The very next step picks the
    // column deterministically through the dropdown, which is where an exact value belongs.
    await fn.click();
    await frame.getByRole("option", { name: "max", exact: true }).click();
    await expect(ta, "crossing count -> max must auto-supply a column; a no-op would leave count(...) and the chip would silently ignore the click").toHaveValue(
      new RegExp(`^max\\(node:${escapeRe(cfg.childId)}\\.[a-z0-9_]+\\)$`, "i"),
    );

    // Now pin the column deterministically through the "Aggregate column" dropdown.
    const colBox = frame.getByRole("combobox", { name: "Aggregate column" });
    await colBox.click();
    await frame.getByRole("option", { name: /^Quantity$/ }).click();
    const EXPECTED = `max(node:${cfg.childId}.sample_quantity)`;
    await expect(ta).toHaveValue(exactly(EXPECTED));

    await expect(mapDialog(frame).getByText("Ready to apply")).toBeVisible();
    await mapDialog(frame).getByRole("button", { name: "Apply", exact: true }).click();

    await toolbar(frame).getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

    const mapping = JSON.parse(String((await actionOf(rule.ruleId)).asx_fieldmapping)) as MappingEntry[];
    expect(mapping.length).toBe(1);
    expect(String(mapping[0].expression).toLowerCase()).toBe(EXPECTED.toLowerCase());
    // No filter was ever authored, so serializeFieldMapping (fieldMapping.ts:144-148) must omit
    // `filters` entirely: an empty object here would be a mapping the engine has to interpret.
    expect(mapping[0].filters).toBeUndefined();
  } finally {
    await deleteRuleCascade(rule.ruleId);
    await rule.cleanup().catch(() => {});
    await cfg.cleanup();
  }
});
