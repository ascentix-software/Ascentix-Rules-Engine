import { describe, it, expect } from "vitest";

describe("entry point", () => {
  it("exposes Ascentix.RulesEngine.onLoad on the global", async () => {
    await import("../src/index");
    const ns = (globalThis as any).Ascentix;
    expect(ns).toBeDefined();
    expect(typeof ns.RulesEngine.onLoad).toBe("function");
  });
});
