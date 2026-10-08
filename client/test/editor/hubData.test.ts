import { describe, it, expect, vi } from "vitest";
import { publishedDefinition, publishedRuleId } from "./publishedFixtures";
import {
  loadHubData, retrieveAll, MAX_PAGES, countByRule, subtreeSize, groupUsedBy,
  loadSchedulerStatus, schedulerChip,
} from "../../src/editor/load/hubData";
import type { WebApiPort } from "../../src/editor/webapi";
import { ENTITY, LOOKUP } from "../../src/editor/load/odata";

const FV = "@OData.Community.Display.V1.FormattedValue";
const ROOT = "11111111-1111-1111-1111-111111111111";
const CHILD = "22222222-2222-2222-2222-222222222222";
const ROOT2 = "33333333-3333-3333-3333-333333333333";
const RULE1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RULE2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("countByRule", () => {
  it("counts action rows per rule", () => {
    const m = countByRule([
      { [LOOKUP.ruleOfAction]: RULE1 }, { [LOOKUP.ruleOfAction]: RULE1 }, { [LOOKUP.ruleOfAction]: RULE2 },
      { [LOOKUP.ruleOfAction]: null },
    ]);
    expect(m.get(RULE1)).toBe(2);
    expect(m.get(RULE2)).toBe(1);
  });
});

describe("subtreeSize", () => {
  it("counts the root and all descendants, cycle-guarded", () => {
    const p = new Map<string, string[]>([[ROOT, [CHILD]], [CHILD, [ROOT]]]); // cycle
    expect(subtreeSize(p, ROOT)).toBe(2);
    expect(subtreeSize(new Map(), ROOT2)).toBe(1);
  });
});

describe("groupUsedBy", () => {
  it("groups rules by rootConfigId, ignoring null", () => {
    const m = groupUsedBy([{ rootConfigId: ROOT }, { rootConfigId: ROOT }, { rootConfigId: null }]);
    expect(m.get(ROOT)).toBe(2);
  });
});

function port(): WebApiPort {
  return {
    retrieveRecord: async () => { throw new Error("unused"); },
    createRecord: async () => { throw new Error("unused"); },
    updateRecord: async () => { throw new Error("unused"); },
    processRunPage: async () => { throw new Error("unused"); },
    validateRule: async () => { throw new Error("unused"); },
    publishRule: async () => { throw new Error("unused"); },
    unpublishRule: async () => { throw new Error("unused"); },
    retrieveMultipleRecords: async (entity) => {
      if (entity === ENTITY.rule) return { entities: [
        { asx_ruleid: RULE1, asx_name: "Rule One", asx_tablelogicalname: "account", statuscode: 1,
          asx_triggers: "1,4", asx_ondemandscope: 2, [LOOKUP.ruleOfTableConfig]: ROOT, modifiedon: "2026-06-20T00:00:00Z",
          ["_modifiedby_value" + FV]: "A. Chen" },
        { asx_ruleid: RULE2, asx_name: "Rule Two", asx_tablelogicalname: "contact", statuscode: 753840000,
          asx_triggers: "1", [LOOKUP.ruleOfTableConfig]: null, modifiedon: "2026-06-19T00:00:00Z" },
      ] };
      if (entity === ENTITY.action) return { entities: [
        { [LOOKUP.ruleOfAction]: RULE1 }, { [LOOKUP.ruleOfAction]: RULE1 },
      ] };
      if (entity === ENTITY.tableConfig) return { entities: [
        { asx_tableconfigid: ROOT, asx_name: "Account tree", asx_tablelogicalname: "account",
          asx_tableconfigtype: 1, [LOOKUP.parentTableOfConfig]: null, modifiedon: "2026-06-18T00:00:00Z" },
        { asx_tableconfigid: CHILD, asx_name: "Contact", asx_tablelogicalname: "contact",
          asx_tableconfigtype: 2, [LOOKUP.parentTableOfConfig]: ROOT, modifiedon: "2026-06-18T00:00:00Z" },
        { asx_tableconfigid: ROOT2, asx_name: "Lead tree", asx_tablelogicalname: "lead",
          asx_tableconfigtype: 1, [LOOKUP.parentTableOfConfig]: null, modifiedon: "2026-06-17T00:00:00Z" },
      ] };
      if (entity === ENTITY.ruleSchedule) return { entities: [] };
      throw new Error("unexpected " + entity);
    },
  };
}

describe("loadHubData", () => {
  it("assembles rules with counts, root names, and modified-by", async () => {
    const { rules } = await loadHubData(port());
    const r1 = rules.find((r) => r.id === RULE1)!;
    expect(r1.actionCount).toBe(2);
    expect(r1.triggers).toEqual([1, 4]);
    expect(r1.rootConfigName).toBe("Account tree");
    expect(r1.modifiedBy).toBe("A. Chen");
    const r2 = rules.find((r) => r.id === RULE2)!;
    expect(r2.actionCount).toBe(0);
    expect(r2.rootConfigName).toBeNull();
    expect(r2.modifiedBy).toBeNull();
  });
  it("selects asx_ondemandscope on the rule query and maps RuleListItem.onDemandScope", async () => {
    let ruleOptions = "";
    const base = port();
    const capturing: WebApiPort = {
      ...base,
      retrieveMultipleRecords: async (entity, options) => {
        if (entity === ENTITY.rule) ruleOptions = options ?? "";
        return base.retrieveMultipleRecords(entity, options);
      },
    };
    const { rules } = await loadHubData(capturing);
    expect(ruleOptions).toContain("asx_ondemandscope");
    expect(rules.find((r) => r.id === RULE1)!.onDemandScope).toBe(2);
    expect(rules.find((r) => r.id === RULE2)!.onDemandScope).toBeNull();
  });

  it("has no scheduled rules when the rule has no On asx_ruleschedule row", async () => {
    const { rules } = await loadHubData(port());
    expect(rules.every((r) => !r.scheduled)).toBe(true);
    expect(rules.every((r) => r.scheduleSummary === undefined)).toBe(true);
  });

  it("maps scheduled + scheduleSummary from an On asx_ruleschedule row", async () => {
    const base = port();
    const scheduledPort: WebApiPort = {
      ...base,
      retrieveMultipleRecords: async (entity, options) => {
        if (entity === ENTITY.ruleSchedule) return { entities: [
          { [LOOKUP.ruleOfSchedule]: RULE1, asx_pattern: 4, asx_every: null, asx_timeofday: "09:00",
            asx_daysofweek: "1,3", asx_dayofmonth: null },
        ] };
        return base.retrieveMultipleRecords(entity, options);
      },
    };
    const { rules } = await loadHubData(scheduledPort);
    const r1 = rules.find((r) => r.id === RULE1)!;
    expect(r1.scheduled).toBe(true);
    expect(r1.scheduleSummary).toBe("Weekly on Mon, Wed at 09:00");
    const r2 = rules.find((r) => r.id === RULE2)!;
    expect(r2.scheduled).toBe(false);
    expect(r2.scheduleSummary).toBeUndefined();
  });

  it("still resolves with the rules, none marked scheduled, when the schedule query rejects " +
    "(schedule table not yet upgraded in / no read privilege on this environment)", async () => {
    const base = port();
    const failingPort: WebApiPort = {
      ...base,
      retrieveMultipleRecords: async (entity, options) => {
        if (entity === ENTITY.ruleSchedule) throw new Error("asx_ruleschedule does not exist");
        return base.retrieveMultipleRecords(entity, options);
      },
    };
    const { rules, truncated } = await loadHubData(failingPort);
    expect(rules.length).toBe(2);
    expect(rules.every((r) => !r.scheduled)).toBe(true);
    expect(rules.every((r) => r.scheduleSummary === undefined)).toBe(true);
    expect(truncated).toBe(false);
  });

  it("selects asx_on eq true and the pattern fields on the schedule query", async () => {
    let scheduleOptions = "";
    const base = port();
    const capturing: WebApiPort = {
      ...base,
      retrieveMultipleRecords: async (entity, options) => {
        if (entity === ENTITY.ruleSchedule) scheduleOptions = options ?? "";
        return base.retrieveMultipleRecords(entity, options);
      },
    };
    await loadHubData(capturing);
    expect(scheduleOptions).toContain("asx_on eq true");
    expect(scheduleOptions).toContain(LOOKUP.ruleOfSchedule);
    expect(scheduleOptions).toContain("asx_pattern");
  });

  it("assembles configs (roots only) with node and used-by counts", async () => {
    const { configs } = await loadHubData(port());
    expect(configs.map((c) => c.id).sort()).toEqual([ROOT, ROOT2].sort());
    const c = configs.find((x) => x.id === ROOT)!;
    expect(c.nodeCount).toBe(2);          // root + 1 child
    expect(c.usedByCount).toBe(1);        // RULE1
    expect(c.rootTableLogicalName).toBe("account");
    const c2 = configs.find((x) => x.id === ROOT2)!;
    expect(c2.nodeCount).toBe(1);
    expect(c2.usedByCount).toBe(0);       // unused
  });
});

describe("retrieveAll (nextLink paging)", () => {
  function pagedPort(pages: number): WebApiPort {
    let calls = 0;
    return {
      retrieveRecord: async () => { throw new Error("unused"); },
      createRecord: async () => { throw new Error("unused"); },
      updateRecord: async () => { throw new Error("unused"); },
      processRunPage: async () => { throw new Error("unused"); },
      validateRule: async () => { throw new Error("unused"); },
      publishRule: async () => { throw new Error("unused"); },
      unpublishRule: async () => { throw new Error("unused"); },
      retrieveMultipleRecords: async (_entity, options) => {
        calls++;
        // Page n carries one row; nextLink present until the last page. Asserts the
        // helper passes the PREVIOUS nextLink verbatim as the next options argument.
        if (calls > 1 && options !== `next:${calls - 1}`) {
          throw new Error(`page ${calls} got options ${options}, wanted next:${calls - 1}`);
        }
        const last = calls >= pages;
        return {
          entities: [{ n: calls }],
          ...(last ? {} : { nextLink: `next:${calls}` }),
        } as any;
      },
    };
  }

  it("follows nextLink to exhaustion and concatenates every page", async () => {
    const r = await retrieveAll(pagedPort(3), "asx_rule", "?$select=x");
    expect(r.entities.map((e: any) => e.n)).toEqual([1, 2, 3]);
    expect(r.truncated).toBe(false);
  });

  it("single page needs no follow and is not truncated", async () => {
    const r = await retrieveAll(pagedPort(1), "asx_rule", "?$select=x");
    expect(r.entities.length).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("stops at the page ceiling and flags truncation instead of looping", async () => {
    const r = await retrieveAll(pagedPort(Number.MAX_SAFE_INTEGER), "asx_rule", "?$select=x");
    expect(r.entities.length).toBe(MAX_PAGES);
    expect(r.truncated).toBe(true);
  });

  it("loadHubData surfaces truncation from any of the three queries", async () => {
    const base = port();
    const truncatingPort: WebApiPort = {
      ...base,
      retrieveMultipleRecords: async (entity, options) => {
        if (entity === ENTITY.action) {
          // actions never stop paging -> hits the ceiling
          return { entities: [{ [LOOKUP.ruleOfAction]: RULE1 }], nextLink: options } as any;
        }
        return base.retrieveMultipleRecords(entity, options);
      },
    };
    const data = await loadHubData(truncatingPort);
    expect(data.truncated).toBe(true);
    expect((await loadHubData(port())).truncated).toBe(false);
  });
});

function statusPort(rows: any[]): WebApiPort {
  return {
    retrieveRecord: async () => { throw new Error("unused"); },
    createRecord: async () => { throw new Error("unused"); },
    updateRecord: async () => { throw new Error("unused"); },
    processRunPage: async () => { throw new Error("unused"); },
    validateRule: async () => { throw new Error("unused"); },
    publishRule: async () => { throw new Error("unused"); },
    unpublishRule: async () => { throw new Error("unused"); },
    retrieveMultipleRecords: async (entity) => {
      if (entity === ENTITY.schedulerStatus) return { entities: rows };
      throw new Error("unexpected " + entity);
    },
  };
}

describe("loadSchedulerStatus", () => {
  it("reports installed: false when there is no status row", async () => {
    const status = await loadSchedulerStatus(statusPort([]));
    expect(status).toEqual({ lastSeenOn: null, installed: false });
  });

  it("reports the last-seen timestamp from the (single) status row", async () => {
    const status = await loadSchedulerStatus(statusPort([{ asx_lastseenon: "2026-09-29T12:00:00Z" }]));
    expect(status).toEqual({ lastSeenOn: "2026-09-29T12:00:00Z", installed: true });
  });
});

describe("schedulerChip", () => {
  const NOW = Date.parse("2026-09-29T12:30:00Z");

  it("is null when nothing is scheduled, regardless of status", () => {
    expect(schedulerChip({ lastSeenOn: null, installed: false }, false, NOW)).toBeNull();
    expect(schedulerChip({ lastSeenOn: "2026-09-29T12:29:00Z", installed: true }, false, NOW)).toBeNull();
  });

  it("shows 'Scheduler not installed' when there is no status row", () => {
    expect(schedulerChip({ lastSeenOn: null, installed: false }, true, NOW))
      .toEqual({ text: "Scheduler not installed", tone: "warning" });
  });

  it("shows 'last ran N minutes ago' (ok) within 30 minutes of now", () => {
    expect(schedulerChip({ lastSeenOn: "2026-09-29T12:15:00Z", installed: true }, true, NOW))
      .toEqual({ text: "Scheduler: last ran 15 minutes ago", tone: "ok" });
  });

  it("uses the singular for one minute", () => {
    expect(schedulerChip({ lastSeenOn: "2026-09-29T12:29:00Z", installed: true }, true, NOW))
      .toEqual({ text: "Scheduler: last ran 1 minute ago", tone: "ok" });
    expect(schedulerChip({ lastSeenOn: "2026-09-29T12:30:00Z", installed: true }, true, NOW))
      .toEqual({ text: "Scheduler: last ran 0 minutes ago", tone: "ok" });
  });

  it("is still running at exactly 30 minutes, and not running just past it", () => {
    expect(schedulerChip({ lastSeenOn: "2026-09-29T12:00:00Z", installed: true }, true, NOW))
      .toEqual({ text: "Scheduler: last ran 30 minutes ago", tone: "ok" });
    const lastSeenOn = "2026-09-29T11:59:59Z"; // 30 minutes and 1 second before NOW
    expect(schedulerChip({ lastSeenOn, installed: true }, true, NOW))
      .toEqual({ text: `Scheduler not running since ${new Date(lastSeenOn).toLocaleString()}`, tone: "warning" });
  });

  it("shows 'not running since {local time}' (warning) past 30 minutes", () => {
    const lastSeenOn = "2026-09-29T11:55:00Z"; // 35 minutes before NOW
    expect(schedulerChip({ lastSeenOn, installed: true }, true, NOW))
      .toEqual({ text: `Scheduler not running since ${new Date(lastSeenOn).toLocaleString()}`, tone: "warning" });
  });
});

describe("loadHubData · published rules at scale", () => {
  // An org with more published rules than Dataverse's 100 concurrent requests: one
  // asx_ReadPublishedRule per rule, all at once, failed the whole hub.
  it("reads 120 published definitions in 5 bulk revision queries, with no per-rule requests", async () => {
    const n = 120;
    const id = (i: number) => `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`;
    const rev = (i: number) => `${String(i).padStart(8, "0")}-1111-1111-1111-111111111111`;
    const revisionQueries: string[] = [];
    const readPublishedRule = vi.fn();
    const api: WebApiPort = {
      ...port(),
      readPublishedRule,
      retrieveMultipleRecords: async (entity, options) => {
        if (entity === ENTITY.rule) return { entities: Array.from({ length: n }, (_, i) => ({
          asx_ruleid: id(i), asx_name: `Row name ${i}`, asx_tablelogicalname: "account", statuscode: 753840000,
          asx_triggers: "1", _asx_publishedrevision_value: rev(i), modifiedon: "2026-10-01T00:00:00Z" })) };
        if (entity === "asx_rulerevision") {
          revisionQueries.push(options ?? "");
          const ids = [...(options ?? "").matchAll(/'([0-9-]{36})'/g)].map((m) => m[1]);
          return { entities: ids.map((r) => {
            const i = Number(r.slice(0, 8));
            // Rule 7's revision doesn't parse: that rule falls back to its own row.
            const definition = i === 7 ? "{not json" : publishedDefinition.split(publishedRuleId).join(id(i));
            return { asx_rulerevisionid: r, asx_definition: definition };
          }) };
        }
        if (entity === ENTITY.action || entity === ENTITY.tableConfig || entity === ENTITY.ruleSchedule) return { entities: [] };
        throw new Error("unexpected " + entity);
      },
    };
    const { rules } = await loadHubData(api);
    expect(readPublishedRule).not.toHaveBeenCalled();
    expect(revisionQueries).toHaveLength(5);
    expect(rules).toHaveLength(n);
    expect(rules[0].name).toBe("Frozen version");      // from the published definition
    expect(rules[0].triggers).toEqual([2, 3]);
    expect(rules[7].name).toBe("Row name 7");          // unparseable revision: the row's own name
  });
});
