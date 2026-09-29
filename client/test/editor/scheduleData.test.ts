import { describe, it, expect, vi } from "vitest";
import { loadRuleSchedule, diffSchedule } from "../../src/editor/schedule/scheduleData";
import { emptySchedule } from "../../src/editor/schedule/scheduleModel";
import type { RuleSchedule } from "../../src/editor/schedule/scheduleModel";
import { ENTITY, ENTITY_SET, BIND_NAV, LOOKUP } from "../../src/editor/load/odata";
import type { WebApiPort } from "../../src/editor/webapi";

function fakeApi(entities: any[]): WebApiPort {
  return {
    retrieveRecord: vi.fn(),
    retrieveMultipleRecords: vi.fn(async () => ({ entities })),
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    processRunPage: vi.fn(),
    validateRule: vi.fn(),
    publishRule: vi.fn(),
    unpublishRule: vi.fn(),
  };
}

describe("loadRuleSchedule", () => {
  it("uses the asx_ruleschedule LOGICAL name, filtered by the rule", async () => {
    const api = fakeApi([]);
    await loadRuleSchedule(api, "rule-1");
    expect(api.retrieveMultipleRecords).toHaveBeenCalledWith(
      ENTITY.ruleSchedule,
      expect.stringContaining(`${LOOKUP.ruleOfSchedule} eq rule-1`),
    );
  });

  it("returns null when the rule has no schedule row", async () => {
    const api = fakeApi([]);
    expect(await loadRuleSchedule(api, "rule-1")).toBeNull();
  });

  it("maps every field, including the multi-select days and the etag", async () => {
    const api = fakeApi([{
      asx_rulescheduleid: "s1",
      asx_on: true,
      asx_pattern: 4,
      asx_every: null,
      asx_timeofday: "09:00",
      asx_daysofweek: "1,3",
      asx_dayofmonth: null,
      asx_nextrunon: "2026-10-01T09:00:00Z",
      asx_lastrunon: "2026-09-24T09:00:00Z",
      _asx_lastrun_value: "run-1",
      asx_lastoutcome: 1,
      "@odata.etag": 'W/"1"',
    }]);
    const result = await loadRuleSchedule(api, "rule-1");
    expect(result).toEqual<RuleSchedule>({
      id: "s1", on: true, pattern: 4, every: null, timeOfDay: "09:00", days: [1, 3],
      dayOfMonth: null, nextRunOn: "2026-10-01T09:00:00Z", lastRunOn: "2026-09-24T09:00:00Z",
      lastRunId: "run-1", lastOutcome: 1, etag: 'W/"1"',
    });
  });

  it("maps a missing pattern to the out-of-range sentinel 0, not a silent default", async () => {
    const api = fakeApi([{ asx_rulescheduleid: "s1", asx_on: false, asx_pattern: null }]);
    const result = await loadRuleSchedule(api, "rule-1");
    expect(result?.pattern).toBe(0);
  });
});

function on(over: Partial<RuleSchedule> = {}): RuleSchedule {
  return { ...emptySchedule(), on: true, pattern: 3, timeOfDay: "09:00", ...over };
}

describe("diffSchedule", () => {
  it("emits nothing when there is no schedule and none is wanted", () => {
    expect(diffSchedule(null, null, "rule-1", true)).toEqual([]);
  });

  it("emits nothing when nothing changed", () => {
    const loaded: RuleSchedule = { ...on(), id: "s1", etag: 'W/"1"' };
    expect(diffSchedule(loaded, { ...loaded }, "rule-1", true)).toEqual([]);
  });

  it("creates nothing for a never-persisted draft that is Off (flipped On then back Off before saving)", () => {
    const draft: RuleSchedule = { ...on(), on: false };
    expect(diffSchedule(null, draft, "rule-1", true)).toEqual([]);
  });

  it("creates a new schedule bound to the active rule", () => {
    const ops = diffSchedule(null, on(), "rule-1", true);
    expect(ops).toHaveLength(1);
    const create = ops[0] as any;
    expect(create.kind).toBe("create");
    expect(create.entity).toBe(ENTITY.ruleSchedule);
    expect(create.set).toBe(ENTITY_SET.ruleSchedule);
    expect(create.binds).toContainEqual({
      navProp: BIND_NAV.scheduleRule, targetSet: ENTITY_SET.rule, ref: { kind: "existing", id: "rule-1" },
    });
    expect(create.attrs).toEqual({
      asx_on: true, asx_pattern: 3, asx_every: null, asx_timeofday: "09:00",
      asx_daysofweek: null, asx_dayofmonth: null,
    });
  });

  it("updates only the changed fields, carrying the etag", () => {
    const loaded: RuleSchedule = { ...on(), id: "s1", etag: 'W/"1"' };
    const next: RuleSchedule = { ...loaded, timeOfDay: "10:00" };
    const ops = diffSchedule(loaded, next, "rule-1", true);
    expect(ops).toEqual([{
      kind: "update", entity: ENTITY.ruleSchedule, set: ENTITY_SET.ruleSchedule, id: "s1",
      attrs: { asx_timeofday: "10:00" }, binds: [], etag: 'W/"1"',
    }]);
  });

  it("turns an On schedule off when the rule no longer applies, ignoring any other draft change", () => {
    const loaded: RuleSchedule = { ...on(), id: "s1", etag: 'W/"2"' };
    const next: RuleSchedule = { ...loaded, timeOfDay: "10:00", pattern: 4 };
    const ops = diffSchedule(loaded, next, "rule-1", false);
    expect(ops).toEqual([{
      kind: "update", entity: ENTITY.ruleSchedule, set: ENTITY_SET.ruleSchedule, id: "s1",
      attrs: { asx_on: false }, binds: [], etag: 'W/"2"',
    }]);
  });

  it("does nothing when the rule no longer applies but the schedule was already off", () => {
    const loaded: RuleSchedule = { ...on(), id: "s1", on: false, etag: 'W/"1"' };
    expect(diffSchedule(loaded, loaded, "rule-1", false)).toEqual([]);
  });

  it("does nothing when the rule no longer applies and there is no schedule row", () => {
    expect(diffSchedule(null, null, "rule-1", false)).toEqual([]);
  });

  it("never writes the engine-owned columns", () => {
    const next = on({
      nextRunOn: "2026-10-01T09:00:00Z", lastRunOn: "2026-09-24T09:00:00Z",
      lastRunId: "run-1", lastOutcome: 1,
    });
    const create = diffSchedule(null, next, "rule-1", true)[0] as any;
    for (const k of Object.keys(create.attrs)) {
      expect(["asx_nextrunon", "asx_lastrunon", "asx_lastrun", "asx_lastoutcome"]).not.toContain(k);
    }

    const loaded: RuleSchedule = { ...on(), id: "s1", etag: 'W/"1"' };
    const updatedNext: RuleSchedule = {
      ...loaded, timeOfDay: "10:00",
      nextRunOn: "2026-10-01T09:00:00Z", lastRunOn: "2026-09-24T09:00:00Z", lastRunId: "run-1", lastOutcome: 1,
    };
    const update = diffSchedule(loaded, updatedNext, "rule-1", true)[0] as any;
    for (const k of Object.keys(update.attrs)) {
      expect(["asx_nextrunon", "asx_lastrunon", "asx_lastrun", "asx_lastoutcome"]).not.toContain(k);
    }
  });
});
