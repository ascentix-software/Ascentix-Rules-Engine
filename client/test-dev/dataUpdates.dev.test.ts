import { describe, it, expect } from "vitest";
import { devOrg } from "./devOrg";

describe("data updates (asx_ApplyDataUpdates)", () => {
  it("reports nothing pending after the pipeline applied updates", async () => {
    const status = await devOrg("sp").applyDataUpdates("Status");
    expect(status.pending).toEqual([]);
    expect(status.done).toBe(true);
    expect(status.required).toBeGreaterThanOrEqual(0);
  });

  it("applies as an administrator and refuses an author", async () => {
    const applied = await devOrg("sp").applyDataUpdates("Apply");
    expect(applied.done).toBe(true);

    const author = devOrg("authorSp");
    const status = await author.applyDataUpdates("Status");
    expect(status.canApply).toBe(false);
    await expect(author.applyDataUpdates("Apply")).rejects.toThrow(/only a System Administrator or System Customizer/);
  });
});
