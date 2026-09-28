import { describe, it, expect, vi } from "vitest";
import { driveRun, startRun, cancelRun, parseRecordFailure, RUN_STATUS } from "../../src/editor/runs/runDriver";
import type { WebApiPort, RunPageResult } from "../../src/editor/webapi";

describe("driveRun", () => {
  it("loops until done and reports each page", async () => {
    const pages: RunPageResult[] = [
      { done: false, status: 2, evaluated: 2, changed: 1, blocked: 0, failed: 0, skipped: 1 },
      { done: true, status: 3, evaluated: 4, changed: 2, blocked: 0, failed: 0, skipped: 2 },
    ];
    const api = { processRunPage: vi.fn(async () => pages.shift()!) } as any;
    const seen: number[] = [];
    const final = await driveRun(api, "r1", (p) => seen.push(p.evaluated), new AbortController().signal);
    expect(seen).toEqual([2, 4]);
    expect(final.status).toBe(3);
  });

  it("retries a page with the failed record after a record-failed error", async () => {
    const api = {
      processRunPage: vi.fn()
        .mockRejectedValueOnce(new Error("asx_ProcessRunPage:record-failed:11111111-1111-1111-1111-111111111111:Access denied"))
        .mockResolvedValueOnce({ done: true, status: 4, evaluated: 1, changed: 0, blocked: 0, failed: 1, skipped: 0 }),
    } as any;
    await driveRun(api, "r1", () => {}, new AbortController().signal);
    expect(api.processRunPage).toHaveBeenLastCalledWith("r1", { recordId: "11111111-1111-1111-1111-111111111111", message: "Access denied" });
  });

  it("stops calling after abort", async () => {
    const controller = new AbortController();
    const page: RunPageResult = { done: false, status: 2, evaluated: 1, changed: 0, blocked: 0, failed: 0, skipped: 0 };
    const api = {
      processRunPage: vi.fn(async () => {
        controller.abort();
        return page;
      }),
    } as any;
    const final = await driveRun(api, "r1", () => {}, controller.signal);
    expect(api.processRunPage).toHaveBeenCalledTimes(1);
    expect(final).toEqual(page);
  });

  it("rethrows errors that are not record failures", async () => {
    const api = { processRunPage: vi.fn().mockRejectedValueOnce(new Error("Rule not found")) } as any;
    await expect(driveRun(api, "r1", () => {}, new AbortController().signal)).rejects.toThrow("Rule not found");
  });
});

describe("parseRecordFailure", () => {
  it("parses record failures and ignores other messages", () => {
    expect(parseRecordFailure("asx_ProcessRunPage:record-failed:11111111-1111-1111-1111-111111111111:x:y"))
      .toEqual({ recordId: "11111111-1111-1111-1111-111111111111", message: "x:y" });
    expect(parseRecordFailure("something else")).toBeNull();
  });

  it("finds the marker anywhere in a wrapped Web API error message", () => {
    expect(parseRecordFailure("A Business Rule triggered: asx_ProcessRunPage:record-failed:11111111-1111-1111-1111-111111111111:Access denied"))
      .toEqual({ recordId: "11111111-1111-1111-1111-111111111111", message: "Access denied" });
  });
});

describe("startRun", () => {
  it("starts a run with record ids", async () => {
    const createRecord = vi.fn(async () => "run1");
    const api = { createRecord } as any as WebApiPort;
    const id = await startRun(api, "rule1", ["a", "b"]);
    expect(id).toBe("run1");
    expect(createRecord).toHaveBeenCalledWith("asx_ruleruns", {
      "asx_rule@odata.bind": "/asx_rules(rule1)",
      asx_recordids: JSON.stringify(["a", "b"]),
    });
  });

  it("starts an all-records run without asx_recordids", async () => {
    const createRecord = vi.fn(async () => "run2");
    const api = { createRecord } as any as WebApiPort;
    const id = await startRun(api, "rule1");
    expect(id).toBe("run2");
    expect(createRecord).toHaveBeenCalledWith("asx_ruleruns", { "asx_rule@odata.bind": "/asx_rules(rule1)" });
  });
});

describe("cancelRun", () => {
  it("PATCHes asx_status to Cancelled (6)", async () => {
    const updateRecord = vi.fn(async () => {});
    const api = { updateRecord } as any as WebApiPort;
    await cancelRun(api, "run1");
    expect(updateRecord).toHaveBeenCalledWith("asx_ruleruns", "run1", { asx_status: RUN_STATUS.Cancelled });
  });
});
