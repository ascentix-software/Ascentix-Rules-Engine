import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../test-dev/devOrg", () => ({ devOrg: () => ({}) }));

import { drainCleanups, queueOrphanedCleanup } from "../test-dev/ruleBehavior/cleanups";

// Run `p` to completion while advancing the fake clock past every pending timer.
async function drain<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const guarded = p.then(
    (v) => { settled = true; return v; },
    (e) => { settled = true; throw e; },
  );
  guarded.catch(() => {});
  while (!settled) await vi.advanceTimersByTimeAsync(1000);
  return guarded;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("drainCleanups", () => {
  it("runs every cleanup last-in first-out and empties the list", async () => {
    const order: string[] = [];
    const list = ["a", "b", "c"].map((n) => async () => { order.push(n); });
    await drainCleanups(list);
    expect(order).toEqual(["c", "b", "a"]);
    expect(list).toHaveLength(0);
  });

  it("retries a failing cleanup until it succeeds", async () => {
    let n = 0;
    const flaky = vi.fn(async () => { if (++n < 3) throw new Error("asx_DeleteRule failed (500)"); });
    await drain(drainCleanups([flaky]));
    expect(flaky).toHaveBeenCalledTimes(3);
  });

  it("keeps a cleanup that still fails in the list, drains the rest, and throws", async () => {
    const ok = vi.fn(async () => {});
    const stuck = vi.fn(async (): Promise<void> => { throw new Error("delete asx_rules(r1) failed (400)"); });
    const list = [ok, stuck];
    await expect(drain(drainCleanups(list, { timeoutMs: 4000 }))).rejects.toThrow(
      /1 fixture cleanup\(s\) failed and are queued for the next drain:\ncleanup: still failing after 4000ms: delete asx_rules\(r1\) failed \(400\)/,
    );
    expect(ok).toHaveBeenCalledTimes(1);
    expect(list).toEqual([stuck]);

    stuck.mockResolvedValue(undefined);
    await drainCleanups(list);
    expect(list).toHaveLength(0);
  });

  it("also drains cleanups queued outside any test's list", async () => {
    const orphan = vi.fn(async () => {});
    queueOrphanedCleanup(orphan);
    await drainCleanups([]);
    expect(orphan).toHaveBeenCalledTimes(1);
    await drainCleanups([]);
    expect(orphan).toHaveBeenCalledTimes(1);
  });
});
