import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDevApi, deleteDevRecord, updateDevRecord, processRunPage, startDueSchedules } from "./devApi";
import { ensureTableConfig, authorRule, type AuthoredRule } from "./ruleBehavior/authoring";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";
import { createSubject } from "./ruleBehavior/subjects";
import { ENTITY_SET, BIND_NAV, LOOKUP } from "../src/editor/load/odata";

// Live proof of rule schedules (docs/Schema.md §2.14 Rule Schedule, §2.15 Scheduler Status, §9
// asx_StartDueSchedules): asx_nextrunon is engine-owned (RuleSchedulePlugin strips it from every
// caller-supplied Target), so "due" can't be forced by writing it directly. Instead this suite
// points a Daily pattern at a UTC time a couple of minutes out and waits for it, the same way a
// real schedule becomes due. The rule is On demand / All records / UTC, fenced by an execution
// condition prefix exactly like ruleRuns.dev.test.ts, so a scheduled "All records" run only ever
// touches the 3 orders this suite seeds. Everything self-cleans: the rule's own delete cascade
// (docs/Schema.md §2.14/§2.13 — deleting the rule deletes its schedule and its runs) backstops
// the explicit cleanup below.
//
// DEV runs the scheduler add-on's flow, which calls asx_StartDueSchedules on its own timer. It can
// start or continue this suite's due schedule before the test's own call does, so the Due and
// Continue tests check what happened to the schedule and the rule's runs, never that the test's own
// call returned the run (the flow runs the same engine code, so the end state is the same).

const TIMESTAMP = Date.now();
const PREFIX = `ZZ_RB_sched_${TIMESTAMP}`;

const api = createDevApi();
let tc: Awaited<ReturnType<typeof ensureTableConfig>>;
let rule: AuthoredRule;
let scheduleId: string;
let orderIds: string[] = [];

async function createOrders(): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await createSubject("sample_orders", { sample_name: `${PREFIX}_${i}`, sample_ordertotal: 500 }));
  }
  return ids;
}

function createSchedule(pattern: number, extra: Record<string, unknown> = {}): Promise<string> {
  return api.createRecord(ENTITY_SET.ruleSchedule, {
    [`${BIND_NAV.scheduleRule}@odata.bind`]: `/${ENTITY_SET.rule}(${rule.ruleId})`,
    asx_on: true,
    asx_pattern: pattern,
    ...extra,
  });
}

function getSchedule(select: string): Promise<any> {
  return api.retrieveRecord(ENTITY_SET.ruleSchedule, scheduleId, `?$select=${select}`);
}

function createRun(): Promise<string> {
  return api.createRecord(ENTITY_SET.ruleRun, {
    [`${BIND_NAV.runRule}@odata.bind`]: `/${ENTITY_SET.rule}(${rule.ruleId})`,
  });
}

// Drives a run to completion by repeatedly calling processRunPage.
async function drive(runId: string): Promise<Awaited<ReturnType<typeof processRunPage>>> {
  let last: Awaited<ReturnType<typeof processRunPage>>;
  do {
    last = await processRunPage(runId);
  } while (!last.done);
  return last;
}

async function activeRuns(): Promise<Array<{ id: string }>> {
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.ruleRun,
    `?$filter=${LOOKUP.ruleOfRun} eq ${rule.ruleId} and (asx_status eq 1 or asx_status eq 2)&$select=asx_rulerunid`,
  );
  return r.entities.map((e: any) => ({ id: e.asx_rulerunid as string }));
}

// Every run of the suite's rule, in any status (lower-cased ids).
async function ruleRunIds(): Promise<string[]> {
  const r = await api.retrieveMultipleRecords(
    ENTITY_SET.ruleRun, `?$filter=${LOOKUP.ruleOfRun} eq ${rule.ruleId}&$select=asx_rulerunid`,
  );
  return r.entities.map((e: any) => (e.asx_rulerunid as string).toLowerCase());
}

async function cancelActiveRuns(): Promise<void> {
  for (const run of await activeRuns()) {
    await updateDevRecord(ENTITY_SET.ruleRun, run.id, { asx_status: 6 }).catch(() => {}); // Cancelled
  }
}

// The UTC "HH:mm" `minutesAhead` minutes from now: both RuleSchedulePlugin and
// asx_StartDueSchedules compute the schedule's next run in the rule's zone, UTC here (the rule's
// asx_evaluationtimezone is left blank).
function utcTimeInMinutes(minutesAhead: number): string {
  const t = new Date(Date.now() + minutesAhead * 60000);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
}

// PATCHes the schedule to Daily at a UTC time 2 minutes out (asx_nextrunon is engine-owned, so
// this is the only way to make it come due naturally), asserts the recomputed Next run on lands
// on that clock time either today or tomorrow (whichever is soonest after "now"), waits until
// 20 seconds past that instant, and returns it for the caller's own tolerance checks.
async function makeDueInTwoMinutes(): Promise<Date> {
  const timeOfDay = utcTimeInMinutes(2);
  await updateDevRecord(ENTITY_SET.ruleSchedule, scheduleId, { asx_pattern: 3 /* Daily */, asx_timeofday: timeOfDay });

  const patched = await getSchedule("asx_nextrunon");
  const nextRunOn = new Date(patched.asx_nextrunon);
  const hh = String(nextRunOn.getUTCHours()).padStart(2, "0");
  const mm = String(nextRunOn.getUTCMinutes()).padStart(2, "0");
  expect(`${hh}:${mm}`).toBe(timeOfDay);

  const now = new Date();
  const nowDayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nextRunDayUtc = Date.UTC(nextRunOn.getUTCFullYear(), nextRunOn.getUTCMonth(), nextRunOn.getUTCDate());
  const dayDiff = Math.round((nextRunDayUtc - nowDayUtc) / 86400000);
  expect([0, 1]).toContain(dayDiff); // today, or tomorrow if the minute already passed

  const waitMs = nextRunOn.getTime() + 20000 - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  return nextRunOn;
}

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  tc = await ensureTableConfig();
  orderIds = await createOrders();

  // On demand, All records, UTC (asx_evaluationtimezone left blank): an execution-condition gate
  // (sample_name begins with our unique prefix) keeps a scheduled "All records" run scoped to the
  // 3 orders this suite created, even though the run itself reads the whole sample_orders table.
  rule = await authorRule({
    name: `sched_${TIMESTAMP}`,
    rootNodeId: tc.order,
    triggers: "3", // On demand
    onDemandScope: 2, // All records that pass its execution conditions
    executionConditions: [
      { nodeId: tc.order, conditionType: 3 /* RegexMatch */, column: "sample_name", literal: `^${PREFIX}` },
    ],
    conditions: [
      { nodeId: tc.order, conditionType: 1, column: "sample_ordertotal", operator: 3 /* GreaterThan */, valueSource: 1, literal: "100" },
    ],
    actions: [
      {
        actionType: 6 /* UpdateRecord */, fireOn: 1, targetNodeId: tc.order,
        fieldMapping: JSON.stringify([{ target: "sample_approvalnotes", source: "literal", value: "scheduled" }]),
      },
    ],
  });
}, 120000);

afterAll(async () => {
  await cancelActiveRuns().catch(() => {});
  for (const id of orderIds) await deleteDevRecord("sample_orders", id).catch(err => console.warn("order cleanup failed:", err));
  await rule.cleanup(); // cascades: deletes the schedule and any runs left on it (docs/Schema.md §2.14/§2.13)
  await tc.cleanup();
}, 120000);

describe("rule schedules", () => {
  it("Not due: no run starts, but the heartbeat still updates", async () => {
    scheduleId = await createSchedule(1 /* EveryMinutes */, { asx_every: 15 });

    const created = await getSchedule("asx_nextrunon");
    const nextRunOn = new Date(created.asx_nextrunon).getTime();
    expect(Math.abs(nextRunOn - (Date.now() + 15 * 60000))).toBeLessThan(2 * 60000);

    const before = await activeRuns();
    expect(before).toHaveLength(0);
    await startDueSchedules();
    const after = await activeRuns();
    expect(after).toHaveLength(0); // this schedule isn't due yet: no run was started

    const status = await api.retrieveMultipleRecords(ENTITY_SET.schedulerStatus, "?$select=asx_lastseenon&$top=1");
    expect(status.entities).toHaveLength(1);
    const lastSeen = new Date(status.entities[0].asx_lastseenon).getTime();
    expect(Date.now() - lastSeen).toBeLessThan(60000);
  }, 60000);

  it("Due: starts a run, advances Next run on by ~24h, and the run applies the rule", async () => {
    const dueAt = await makeDueInTwoMinutes();

    await startDueSchedules();

    const runs = await api.retrieveMultipleRecords(
      ENTITY_SET.ruleRun, `?$filter=${LOOKUP.ruleOfRun} eq ${rule.ruleId}&$select=asx_rulerunid`,
    );
    expect(runs.entities).toHaveLength(1);
    const runId = runs.entities[0].asx_rulerunid as string;

    const after = await getSchedule("asx_lastoutcome,asx_nextrunon");
    expect(after.asx_lastoutcome).toBe(1); // Started a run

    const nextRunOn = new Date(after.asx_nextrunon).getTime();
    expect(Math.abs(nextRunOn - (dueAt.getTime() + 24 * 60 * 60000))).toBeLessThan(2 * 60000);

    const last = await drive(runId);
    expect(last.status).toBe(3); // Completed
    for (const id of orderIds) {
      const order = await api.retrieveRecord("sample_orders", id, "?$select=sample_approvalnotes");
      expect(order.sample_approvalnotes).toBe("scheduled");
    }
  }, 240000);

  it("Continue: a schedule due while its rule already has an active run continues that run", async () => {
    const earlier = new Set(await ruleRunIds()); // the Due test's run
    // The live scheduler flow (every 15 minutes) also drives any Queued/Running run of a rule with
    // an On schedule (docs/Schema.md, asx_StartDueSchedules RunIds). A Queued run created BEFORE the
    // ~2 minute wait for the due time could be driven to completion by a tick during that wait,
    // leaving nothing active to continue. So the run is created only once the schedule is due, just
    // before the call; a tick in that last second continues it itself, which passes the same way.
    // A tick in the wait's final 20 seconds (after the due instant) starts a run on its own: then
    // there is nothing to test continuing, so cancel that run and make the schedule due again, once.
    let runId = "";
    for (let attempt = 1; !runId; attempt++) {
      await makeDueInTwoMinutes();
      const flowStarted = (await ruleRunIds()).filter((id) => !earlier.has(id));
      if (!flowStarted.length) {
        runId = await createRun(); // left Queued deliberately: no processRunPage call
        break;
      }
      if (attempt === 2) throw new Error(`the live scheduler flow started this rule's due run itself twice (${flowStarted.join(", ")}), so Continue could not be exercised`);
      await cancelActiveRuns();
      for (const id of flowStarted) earlier.add(id);
    }

    await startDueSchedules();

    const after = await getSchedule("asx_lastoutcome");
    expect(after.asx_lastoutcome).toBe(2); // Continued the active run

    // No second run was created. The run may already have finished: when the flow continues a run
    // it also drives it, so this counts every run the rule gained during this test, in any status.
    const gained = (await ruleRunIds()).filter((id) => !earlier.has(id));
    expect(gained).toEqual([runId.toLowerCase()]);

    await cancelActiveRuns();
  }, 420000); // up to two ~2.5 minute waits for the due time
});
