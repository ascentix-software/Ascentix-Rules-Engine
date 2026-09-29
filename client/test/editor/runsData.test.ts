import { describe, it, expect, vi } from "vitest";
import { isStale, loadRuns, type RunRow } from "../../src/editor/runs/runsData";
import type { WebApiPort } from "../../src/editor/webapi";

const NOW = new Date("2026-09-28T12:00:00Z").getTime();

function row(over: Partial<RunRow>): RunRow {
  return {
    id: "r1", status: 2, evaluated: 0, changed: 0, blocked: 0, failed: 0, skipped: 0,
    startedOn: null, lastPageOn: null, finishedOn: null, startedBy: null, failures: [], ...over,
  };
}

describe("loadRuns", () => {
  // Xrm.WebApi.retrieveMultipleRecords needs the table's LOGICAL name (asx_rulerun), not the
  // entity set name (asx_ruleruns): the dev/test fakes accept either, which hid this bug.
  it("queries by the rulerun's logical name", async () => {
    const retrieveMultipleRecords = vi.fn(async () => ({ entities: [] }));
    const api = { retrieveMultipleRecords } as any as WebApiPort;
    await loadRuns(api, "rule1");
    expect(retrieveMultipleRecords).toHaveBeenCalledWith("asx_rulerun", expect.stringContaining("rule1"));
  });
});

describe("isStale", () => {
  it("a Running run is stale once its last page is more than two minutes old", () => {
    expect(isStale(row({ status: 2, lastPageOn: "2026-09-28T11:50:00Z" }), NOW)).toBe(true);
    expect(isStale(row({ status: 2, lastPageOn: "2026-09-28T11:59:30Z" }), NOW)).toBe(false);
    expect(isStale(row({ status: 2, lastPageOn: null }), NOW)).toBe(true);
  });

  it("a Queued run that never reported a page is stale once it was started more than two minutes ago", () => {
    expect(isStale(row({ status: 1, startedOn: "2026-09-28T11:55:00Z" }), NOW)).toBe(true);
    expect(isStale(row({ status: 1, startedOn: "2026-09-28T11:59:30Z" }), NOW)).toBe(false);
    expect(isStale(row({ status: 1, startedOn: null }), NOW)).toBe(true);
  });

  it("a Queued run goes by its last page when it has one", () => {
    expect(isStale(row({ status: 1, startedOn: "2026-09-28T10:00:00Z", lastPageOn: "2026-09-28T11:59:30Z" }), NOW)).toBe(false);
  });

  it("a finished run is never stale", () => {
    for (const status of [3, 4, 5, 6])
      expect(isStale(row({ status, startedOn: "2026-09-28T10:00:00Z", lastPageOn: "2026-09-28T10:00:00Z" }), NOW)).toBe(false);
  });
});
