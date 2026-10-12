import { describe, it, expect } from "vitest";
import {
  SCHEDULE_PATTERN_OPTIONS, MINUTE_OPTIONS, HOUR_OPTIONS, DAY_OPTIONS, DAY_OF_MONTH_OPTIONS,
  emptySchedule, validateSchedule, scheduleApplies, scheduleOutcomeLabel,
} from "../../src/editor/schedule/scheduleModel";
import type { RuleSchedule } from "../../src/editor/schedule/scheduleModel";
import type { RuleHeader } from "../../src/editor/model/types";

function schedule(over: Partial<RuleSchedule> = {}): RuleSchedule {
  return { ...emptySchedule(), on: true, ...over };
}

function rule(over: Partial<RuleHeader> = {}): RuleHeader {
  return {
    id: "r1", name: "Rule", tableLogicalName: "account", statusCode: 1, etag: null,
    triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
    rootTableConfigId: null, triggerColumns: [], ...over,
  };
}

describe("scheduleModel option lists", () => {
  it("SCHEDULE_PATTERN_OPTIONS has the 5 labels in order", () => {
    expect(SCHEDULE_PATTERN_OPTIONS).toEqual([
      { value: 1, label: "Every N minutes" },
      { value: 2, label: "Every N hours" },
      { value: 3, label: "Daily" },
      { value: 4, label: "Weekly" },
      { value: 5, label: "Monthly" },
    ]);
  });

  it("MINUTE_OPTIONS offers exactly 15/30/45", () => {
    expect(MINUTE_OPTIONS).toEqual([15, 30, 45]);
  });

  it("HOUR_OPTIONS offers 1..23", () => {
    expect(HOUR_OPTIONS).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  it("DAY_OPTIONS is Sunday(0)..Saturday(6)", () => {
    expect(DAY_OPTIONS.map((o) => o.value)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(DAY_OPTIONS[0].label).toBe("Sunday");
    expect(DAY_OPTIONS[6].label).toBe("Saturday");
  });

  it("DAY_OF_MONTH_OPTIONS is 1..31", () => {
    expect(DAY_OF_MONTH_OPTIONS).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });
});

describe("validateSchedule", () => {
  it("flags an undefined pattern", () => {
    expect(validateSchedule(schedule({ pattern: 0 as any }))).toBe("Choose how often the schedule runs.");
  });

  it("Every N minutes must be 15, 30 or 45", () => {
    expect(validateSchedule(schedule({ pattern: 1, every: 20 }))).toBe("Every N minutes must be 15, 30 or 45.");
    expect(validateSchedule(schedule({ pattern: 1, every: 15 }))).toBeNull();
  });

  it("Every N hours must be between 1 and 23", () => {
    expect(validateSchedule(schedule({ pattern: 2, every: 0 }))).toBe("Every N hours must be between 1 and 23.");
    expect(validateSchedule(schedule({ pattern: 2, every: 24 }))).toBe("Every N hours must be between 1 and 23.");
    expect(validateSchedule(schedule({ pattern: 2, every: 12 }))).toBeNull();
  });

  it("requires a time of day for daily/weekly/monthly", () => {
    expect(validateSchedule(schedule({ pattern: 3, timeOfDay: null }))).toBe("Choose a time of day for a daily, weekly or monthly schedule.");
  });

  it("rejects a malformed time of day", () => {
    expect(validateSchedule(schedule({ pattern: 3, timeOfDay: "9:00" }))).toBe("Time of day must be HH:mm (24-hour).");
    expect(validateSchedule(schedule({ pattern: 3, timeOfDay: "24:00" }))).toBe("Time of day must be HH:mm (24-hour).");
    expect(validateSchedule(schedule({ pattern: 3, timeOfDay: "09:00" }))).toBeNull();
  });

  it("requires at least one day for weekly", () => {
    expect(validateSchedule(schedule({ pattern: 4, timeOfDay: "09:00", days: [] }))).toBe("Choose at least one day for a weekly schedule.");
    expect(validateSchedule(schedule({ pattern: 4, timeOfDay: "09:00", days: [1] }))).toBeNull();
  });

  it("requires a day of month for monthly", () => {
    expect(validateSchedule(schedule({ pattern: 5, timeOfDay: "09:00", dayOfMonth: null }))).toBe("Choose a day of the month for a monthly schedule.");
    expect(validateSchedule(schedule({ pattern: 5, timeOfDay: "09:00", dayOfMonth: 32 }))).toBe("Choose a day of the month for a monthly schedule.");
    expect(validateSchedule(schedule({ pattern: 5, timeOfDay: "09:00", dayOfMonth: 15 }))).toBeNull();
  });
});

describe("scheduleApplies", () => {
  it("is true only for On demand + Runs for = All records", () => {
    expect(scheduleApplies(rule({ triggers: [3], onDemandScope: 2 }))).toBe(true);
    expect(scheduleApplies(rule({ triggers: [1], onDemandScope: 2 }))).toBe(false);
    expect(scheduleApplies(rule({ triggers: [3], onDemandScope: 1 }))).toBe(false);
    expect(scheduleApplies(rule({ triggers: [3], onDemandScope: null }))).toBe(false);
    expect(scheduleApplies(rule({ triggers: [3, 4], onDemandScope: 2 }))).toBe(true);
  });
});

describe("scheduleOutcomeLabel", () => {
  it("maps 1-3 and passes through null", () => {
    expect(scheduleOutcomeLabel(1)).toBe("Started a run");
    expect(scheduleOutcomeLabel(2)).toBe("Continued the active run");
    expect(scheduleOutcomeLabel(3)).toBe("Rule not runnable");
    expect(scheduleOutcomeLabel(null)).toBeNull();
  });
});
