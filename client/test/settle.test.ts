import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The settle oracle (client/test-dev/ruleBehavior/settle.ts) under fake timers, with no network:
// the DevOrg module is mocked so the named probes (dataVisible, configsVisible) run hermetically.
const runRules = vi.fn();
const retrieveMultipleRecords = vi.fn();
vi.mock("../test-dev/devOrg", () => ({
  devOrg: () => ({ runRules, api: { retrieveMultipleRecords } }),
}));

import { settle, enforcementSettled, dataVisible, configsVisible, traversalDiagnostics } from "../test-dev/ruleBehavior/settle";

// Run `p` to completion while advancing the fake clock past every pending timer.
async function drain<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const guarded = p.then(
    (v) => { settled = true; return v; },
    (e) => { settled = true; throw e; },
  );
  guarded.catch(() => {});
  while (!settled) await vi.advanceTimersByTimeAsync(500);
  return guarded;
}

beforeEach(() => {
  vi.useFakeTimers();
  runRules.mockReset();
  retrieveMultipleRecords.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("settle core", () => {
  it("returns on the first true without waiting", async () => {
    const probe = vi.fn(async () => true);
    await settle(probe, { label: "x" });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries at the interval until the probe agrees", async () => {
    let n = 0;
    const probe = vi.fn(async () => ++n >= 3);
    const p = settle(probe, { label: "x", intervalMs: 1000, capMs: 30000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(3);
    await p;
  });

  it("times out past the cap with the label, the caller's message and the diagnostic", async () => {
    const probe = vi.fn(async () => false);
    await expect(drain(settle(probe, { label: "my-probe", capMs: 3000, intervalMs: 1000 }))).rejects.toThrow(
      /^my-probe: not settled within 3000ms$/,
    );
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(4); // 0s,1s,2s,3s and the >cap attempt

    await expect(
      drain(settle(probe, {
        label: "L", capMs: 2000, intervalMs: 1000,
        timeoutMessage: ({ label, capMs, attempts }) => `${label} gave up after ${capMs}ms/${attempts} attempts.`,
        diagnostic: async () => "Traversal saw: sample_orderline:0",
      })),
    ).rejects.toThrow(/^L gave up after 2000ms\/\d+ attempts\. Traversal saw: sample_orderline:0$/);
  });

  it("a failing diagnostic never replaces the timeout; a throwing probe propagates at once", async () => {
    await expect(
      drain(settle(async () => false, { label: "D", capMs: 1000, intervalMs: 500, diagnostic: () => { throw new Error("no diag"); } })),
    ).rejects.toThrow("D: not settled within 1000ms (diagnostic unavailable: no diag)");

    const probe = vi.fn(async () => { throw new Error("assertion inside probe"); });
    await expect(settle(probe, { label: "P" })).rejects.toThrow("assertion inside probe");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("named probes", () => {
  it("enforcementSettled keeps awaitEnforcement's message (30s cap, 1s interval)", async () => {
    const probe = vi.fn(async () => false);
    await expect(drain(enforcementSettled(probe, { label: "ZZ_RB_dead" }))).rejects.toThrow(
      "awaitEnforcement: enforcement not observed within 30000ms (ZZ_RB_dead) — step cache never settled or the rule is dead",
    );
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(31);
    await expect(drain(enforcementSettled(async () => false, { capMs: 500, intervalMs: 100 }))).rejects.toThrow(
      /^awaitEnforcement: enforcement not observed within 500ms — step cache/,
    );
  });

  it("dataVisible polls asx_RunRules until the verdict agrees; on timeout reports the traversal rows", async () => {
    runRules
      .mockResolvedValueOnce({ firedActions: [] })
      .mockResolvedValueOnce({ firedActions: [{ Message: "Too big." }] });
    await drain(dataVisible("sample_order", "id", { expectMessage: "Too big.", expectFired: true, recordJson: "{}" }));
    expect(runRules).toHaveBeenCalledTimes(2);
    expect(runRules.mock.calls[0]).toEqual(["sample_order", { recordId: "id", recordJson: "{}", triggers: "4" }]);

    runRules.mockReset();
    runRules.mockImplementation(async (_t: string, o: any) =>
      o.includeDiagnostics
        ? { firedActions: [], diagnostics: { nodes: [{ table: "sample_order", rows: 1 }, { nodeId: "n2", rows: 0 }] } }
        : { firedActions: [] });
    await expect(
      drain(dataVisible("sample_order", "id", { expectMessage: "Too big.", expectFired: true, capMs: 2000 })),
    ).rejects.toThrow(
      'awaitEngineVerdict: after 2000ms the engine still does not fire "Too big." for sample_order(id), expected fired. ' +
        "Traversal saw: sample_order:1, n2:0",
    );
  });

  it("traversalDiagnostics is best-effort", async () => {
    runRules.mockResolvedValueOnce({ diagnostics: null });
    expect(await traversalDiagnostics("t", "id", "4")).toBe("(no diagnostics returned)");
    runRules.mockResolvedValueOnce({ diagnostics: { nodes: [] } });
    expect(await traversalDiagnostics("t", "id", "4")).toBe("(no traversal nodes fetched)");
    runRules.mockRejectedValueOnce(new Error("asx_RunRules failed (500): x"));
    expect(await traversalDiagnostics("t", "id", "4")).toBe("(diagnostics unavailable: asx_RunRules failed (500): x)");
  });

  it("configsVisible waits for every node (500ms interval) and reports the count on timeout", async () => {
    retrieveMultipleRecords
      .mockResolvedValueOnce({ entities: [{}] })
      .mockResolvedValueOnce({ entities: [{}, {}] });
    await drain(configsVisible(["a", "b"]));
    expect(retrieveMultipleRecords).toHaveBeenCalledTimes(2);
    expect(retrieveMultipleRecords.mock.calls[0][1]).toBe("?$filter=asx_tableconfigid eq a or asx_tableconfigid eq b&$select=asx_tableconfigid");

    retrieveMultipleRecords.mockReset();
    retrieveMultipleRecords.mockResolvedValue({ entities: [{}] });
    await expect(drain(configsVisible(["a", "b"], 1000))).rejects.toThrow(
      "awaitConfigsVisible: only 1/2 table-config nodes became visible within 1000ms — the org never made the freshly created tree readable.",
    );
  });
});
