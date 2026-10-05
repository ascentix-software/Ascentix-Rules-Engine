import { describe, it, expect, vi } from "vitest";
import { parseItemFailure, driveDataUpdates } from "../../src/editor/dataUpdates/applyDriver";
import { parseDataUpdateStatus } from "../../src/editor/webapi";

const status = (done: boolean, latestStatus?: number) => ({
  required: 1, pending: done ? [] : [{ number: 1, title: "T" }],
  latest: latestStatus ? { number: 1, title: "T", status: latestStatus, succeeded: 0, failed: 0, failures: [] } : null,
  canApply: true, done,
});

describe("data update driver", () => {
  it("parses an item-failed error, even when wrapped", () => {
    expect(parseItemFailure("Wrapped: asx_ApplyDataUpdates:item-failed:abc-1:It broke: badly"))
      .toEqual({ item: "abc-1", message: "It broke: badly" });
    expect(parseItemFailure("Something else")).toBeNull();
  });

  it("calls Apply until done and re-calls with a failed item", async () => {
    const api = { applyDataUpdates: vi.fn()
      .mockResolvedValueOnce(status(false))
      .mockRejectedValueOnce(new Error("asx_ApplyDataUpdates:item-failed:i2:boom"))
      .mockResolvedValueOnce(status(false))
      .mockResolvedValueOnce(status(true)) };
    const progress = vi.fn();
    const last = await driveDataUpdates(api, undefined, progress, new AbortController().signal);
    expect(last?.done).toBe(true);
    expect(api.applyDataUpdates).toHaveBeenNthCalledWith(3, "Apply", { failed: { item: "i2", message: "boom" } });
    expect(api.applyDataUpdates).toHaveBeenNthCalledWith(4, "Apply", {});
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it("keeps sending a retry until a call succeeds", async () => {
    const api = { applyDataUpdates: vi.fn()
      .mockRejectedValueOnce(new Error("asx_ApplyDataUpdates:item-failed:i1:boom"))
      .mockResolvedValueOnce(status(true)) };
    await driveDataUpdates(api, 1, () => {}, new AbortController().signal);
    expect(api.applyDataUpdates).toHaveBeenNthCalledWith(1, "Apply", { retry: 1 });
    expect(api.applyDataUpdates).toHaveBeenNthCalledWith(2, "Apply", { retry: 1, failed: { item: "i1", message: "boom" } });
  });

  it("rethrows any other error", async () => {
    const api = { applyDataUpdates: vi.fn().mockRejectedValue(new Error("Access denied")) };
    await expect(driveDataUpdates(api, undefined, () => {}, new AbortController().signal)).rejects.toThrow("Access denied");
  });

  it("parses the API's raw outputs", () => {
    expect(parseDataUpdateStatus({ Required: 2, Pending: "[{\"number\":2,\"title\":\"Two\"}]", Latest: "null", CanApply: true, Done: false }))
      .toEqual({ required: 2, pending: [{ number: 2, title: "Two" }], latest: null, canApply: true, done: false });
    expect(parseDataUpdateStatus({}).pending).toEqual([]);
  });
});
