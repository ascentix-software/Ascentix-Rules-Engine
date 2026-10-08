import { test, expect } from "@playwright/test";
import { createDevApi, deleteDevRecord, updateDevRecord } from "../test-dev/devApi";
import { ENTITY_SET } from "../src/editor/load/odata";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId, createZzRootConfig, createRuleRun, driveRunToCompletion } from "./devHelpers";
import { openRuleFromHub, runMenu } from "./editorHarness";

// The Runs dialog (RunsDialog.tsx): the table's status/counts, a selected run's failures (with a
// record link), and Cancel on an unfinished run. docs/guide/03-administering/04-running-rules-on-demand.md.
//
// Both runs are arranged directly via the API (createRuleRun + driveRunToCompletion, the same
// asx_ProcessRunPage loop runs/runDriver.ts drives in the browser) rather than through the Run
// now dialog: runNowUi.e2e already covers that surface, and driving "given records" runs here
// keeps this spec fast and independent of DEV's total sample_orders row count.

// Case-insensitive: a record guid travels REST -> UI -> REST and nothing guarantees the casing
// survives identical (same rationale as aggregateFiltersUi.e2e's `exactly` helper).
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactly = (s: string) => new RegExp(`^${escapeRe(s)}$`, "i");

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

test("Runs dialog: a completed run's blocked failure links its record, and a Queued run offers Cancel", async ({ page }) => {
  const appId = await resolveAppId();
  const api = createDevApi();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Rule A: a Given-records run with one matching (Changed) and one non-matching (Blocked)
  // record, driven to completion before the UI ever sees it.
  // Distinct base names for the config and the rule: createZzRootConfig and authorRule both just
  // ZZ_RB_-prefix whatever they're given (authorRule does NOT append "_rule" itself), so sharing
  // one base string makes the hub render the rule's own name and its "uses <config>" name
  // IDENTICALLY — a strict-mode trap for getByText(exact:true) inside openRuleFromHub (hit live:
  // two elements with that exact text in the same hub row, the name div and the "uses" span).
  const rootA = await createZzRootConfig(`rdA_${stamp}_cfg`, "sample_order");
  const ruleA = await authorRule({
    name: `rdA_${stamp}_rule`,
    rootNodeId: rootA.id,
    triggers: "3",
    conditions: [
      { nodeId: rootA.id, conditionType: 1, column: "sample_ordertotal", operator: 3 /* GreaterThan */, valueSource: 1, literal: "100" },
    ],
    actions: [
      {
        actionType: 6 /* UpdateRecord */, fireOn: 1, targetNodeId: rootA.id,
        fieldMapping: JSON.stringify([{ target: "sample_approvalnotes", source: "literal", value: "ZZ_E2E_rd ok" }]),
      },
      { actionType: 4 /* Block */, fireOn: 2, message: "ZZ_E2E_rd too small" },
    ],
  });

  // Rule B: a second, otherwise-unrelated On demand rule whose run is created and never driven,
  // so it stays Queued (arranged "via API for another On demand rule", per the brief — the
  // update guard (RuleRunUpdatePlugin) only allows a run's own status -> Cancelled after create,
  // and RuleRunPlugin always stamps asx_startedon = DateTime.UtcNow on create regardless of what
  // the caller sends, so a Queued row can't be backdated past the 2-minute staleness window here.
  // Resume (which only appears on a stale Queued/Running row) is therefore not exercised by this
  // spec; Cancel, which every active row always offers regardless of age, is.
  // onDemandScope: 2 (All records), not the default 1 (Given record): RuleRunPlugin.cs rejects a
  // Create with zero record ids outright when the rule's OWN scope is "Given record" ("This rule
  // runs for records it's given. Choose the records to run it for."), before it ever gets to
  // stamping the run Queued — so a no-recordIds run needs an All-records rule to create at all,
  // even though this run is only ever left Queued, never driven.
  const rootB = await createZzRootConfig(`rdB_${stamp}_cfg`, "sample_order");
  const ruleB = await authorRule({
    name: `rdB_${stamp}_rule`,
    rootNodeId: rootB.id,
    triggers: "3",
    onDemandScope: 2,
    conditions: [
      { nodeId: rootB.id, conditionType: 1, column: "sample_ordertotal", operator: 4 /* GreaterThanOrEqual */, valueSource: 1, literal: "0" },
    ],
    actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1, message: "ZZ_E2E_rd msg", severity: 1 }],
  });

  let matchId: string | undefined;
  let blockId: string | undefined;
  let runBId: string | undefined;
  try {
    matchId = await api.createRecord("sample_orders", { sample_name: `ZZ_E2E_rd_${stamp}_match`, sample_ordertotal: 500 });
    blockId = await api.createRecord("sample_orders", { sample_name: `ZZ_E2E_rd_${stamp}_block`, sample_ordertotal: 50 });

    const runAId = await createRuleRun(ruleA.ruleId, [matchId, blockId]);
    const finished = await driveRunToCompletion(runAId);
    expect(finished.status).toBe(4); // Completed with failures (a Blocked record counts as one)
    expect(finished.changed).toBe(1);
    expect(finished.blocked).toBe(1);

    runBId = await createRuleRun(ruleB.ruleId); // no recordIds given: stays Queued until driven

    // --- Part 1: the completed run's row and its failure's record link ----------------------
    const frameA = await openRuleFromHub(page, appId, ruleA.ruleName);
    await runMenu(frameA, "View runs");
    const runsDialogA = frameA.getByRole("dialog", { name: `Runs · ${ruleA.ruleName}` });
    await expect(runsDialogA).toBeVisible({ timeout: 30_000 });

    // Each run is a rowgroup: its row, then (expanded) its failures.
    const rowA = runsDialogA.getByRole("rowgroup");
    await expect(rowA).toHaveCount(1, { timeout: 30_000 });
    const cellsA = rowA.getByRole("cell");
    // Cells: expander · Status · Started · Changed · Blocked · Failed · Checked · actions.
    await expect(cellsA.nth(1)).toHaveText(/^\d+ failed$/);
    await expect(cellsA.nth(3)).toHaveText("1"); // Changed
    await expect(cellsA.nth(4)).toHaveText("1"); // Blocked
    await expect(cellsA.nth(6)).toHaveText("2"); // Checked

    await rowA.getByRole("button", { name: "Show failures" }).click();
    // The failure names its record (resolved in one query per table) and links to it.
    const link = runsDialogA.getByRole("link", { name: exactly(`ZZ_E2E_rd_${stamp}_block`) });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", new RegExp(`etn=sample_order&id=${escapeRe(blockId)}`, "i"));
    // The engine renders a Block's failure as its standard formatted message — a header line
    // plus a bulleted list of the fired Block(s)' own text — not the bare message alone.
    await expect(runsDialogA.getByText(/could not be saved:[\s\S]*ZZ_E2E_rd too small/)).toBeVisible();

    // --- Part 2: a Queued run always offers Stop ---------------------------------------------
    const frameB = await openRuleFromHub(page, appId, ruleB.ruleName);
    await runMenu(frameB, "View runs");
    const runsDialogB = frameB.getByRole("dialog", { name: `Runs · ${ruleB.ruleName}` });
    await expect(runsDialogB).toBeVisible({ timeout: 30_000 });

    const rowB = runsDialogB.getByRole("rowgroup");
    await expect(rowB).toHaveCount(1, { timeout: 30_000 });
    await expect(rowB).toContainText("Queued");
    await expect(rowB.getByRole("button", { name: "Resume" })).toHaveCount(0);

    await rowB.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(rowB).toContainText("Cancelled", { timeout: 30_000 });
    runBId = undefined; // already Cancelled through the UI; nothing left for cleanup to cancel
  } finally {
    if (runBId) await updateDevRecord(ENTITY_SET.ruleRun, runBId, { asx_status: 6 }).catch(() => {}); // Cancelled
    for (const id of [matchId, blockId]) if (id) await deleteDevRecord("sample_orders", id).catch(() => {});
    await ruleA.cleanup().catch(() => {}); // deleteRuleCascade also deletes its runs (docs/Schema.md §2.13)
    await ruleB.cleanup().catch(() => {});
    await rootA.cleanup();
    await rootB.cleanup();
  }
});
