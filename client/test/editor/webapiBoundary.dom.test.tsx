import { describe, it, expect, vi, afterEach } from "vitest";
import { createWebApiPort } from "../../src/editor/webapi";

function fakeXrm(overrides: any = {}) {
  return {
    WebApi: {
      createRecord: vi.fn(async () => ({ id: "{ABC-123}" })),
      retrieveRecord: vi.fn(),
      retrieveMultipleRecords: vi.fn(),
      ...overrides.WebApi,
    },
    Utility: { getGlobalContext: () => ({ getClientUrl: () => "https://dev.example" }) },
    ...overrides,
  };
}

afterEach(() => {
  delete (window as any).Xrm;
  vi.restoreAllMocks();
});

describe("createWebApiPort / resolveXrm boundary", () => {
  it("resolves Xrm from window when present", () => {
    (window as any).Xrm = fakeXrm();
    const api = createWebApiPort();
    expect(api.getClientUrl()).toBe("https://dev.example");
  });

  it("falls back to window.parent.Xrm when window.Xrm is absent", () => {
    delete (window as any).Xrm;
    const parentXrm = fakeXrm();
    Object.defineProperty(window, "parent", { value: { Xrm: parentXrm }, configurable: true });
    const api = createWebApiPort();
    expect(api.getClientUrl()).toBe("https://dev.example");
  });

  it("throws a clear error when no Xrm is available", () => {
    delete (window as any).Xrm;
    Object.defineProperty(window, "parent", { value: {}, configurable: true });
    expect(() => createWebApiPort()).toThrow(/Xrm\.WebApi is not available/);
  });

  it("createRecord unwraps the GUID braces from Xrm's return", async () => {
    (window as any).Xrm = fakeXrm();
    const api = createWebApiPort();
    const id = await api.createRecord("asx_rules", { asx_name: "x" });
    expect(id).toBe("ABC-123"); // braces stripped
  });

  it("fetchJson throws on a non-ok response", async () => {
    (window as any).Xrm = fakeXrm();
    const api = createWebApiPort();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as any);
    await expect(api.fetchJson("EntityDefinitions")).rejects.toThrow(/Metadata fetch failed \(404\)/);
  });

  it("fetchJson returns parsed JSON on ok", async () => {
    (window as any).Xrm = fakeXrm();
    const api = createWebApiPort();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ value: [1] }) })) as any);
    await expect(api.fetchJson("x")).resolves.toEqual({ value: [1] });
  });
});
