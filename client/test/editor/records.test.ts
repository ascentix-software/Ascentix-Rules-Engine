import { describe, it, expect, vi } from "vitest";
import { buildRecordSearchOptions, createRecordSearchService } from "../../src/editor/records";

describe("buildRecordSearchOptions", () => {
  it("builds a filtered query and escapes single quotes", () => {
    expect(buildRecordSearchOptions("name", "ac", 20))
      .toBe("?$select=name&$filter=contains(name,'ac')&$top=20");
    expect(buildRecordSearchOptions("name", "O'Brien", 20))
      .toBe("?$select=name&$filter=contains(name,'O''Brien')&$top=20");
  });
  it("omits the filter when the query is blank", () => {
    expect(buildRecordSearchOptions("name", "   ", 10)).toBe("?$select=name&$top=10");
  });
});

const meta = {
  tables: async () => [
    { logicalName: "account", displayName: "Account", entitySetName: "accounts", primaryNameAttribute: "name", primaryIdAttribute: "accountid" },
    { logicalName: "contact", displayName: "Contact", entitySetName: "contacts", primaryNameAttribute: "fullname", primaryIdAttribute: "contactid" },
  ],
} as any;

describe("record search service", () => {
  it("searches records and maps id/name from the table's primary attributes", async () => {
    const api: any = {
      retrieveMultipleRecords: vi.fn(async () => ({ entities: [{ accountid: "g1", name: "Acme" }] })),
      retrieveRecord: vi.fn(),
    };
    const svc = createRecordSearchService(api, meta);
    const res = await svc.search("account", "ac");
    expect(res).toEqual([{ id: "g1", name: "Acme" }]);
    expect(api.retrieveMultipleRecords).toHaveBeenCalledWith("account", "?$select=name&$filter=contains(name,'ac')&$top=20");
  });
  it("resolveName probes candidate tables and returns the first hit", async () => {
    const api: any = {
      retrieveMultipleRecords: vi.fn(),
      retrieveRecord: vi.fn(async (table: string) => {
        if (table === "account") throw new Error("404");
        return { fullname: "Jane Doe" };
      }),
    };
    const svc = createRecordSearchService(api, meta);
    expect(await svc.resolveName(["account", "contact"], "g9")).toBe("Jane Doe");
  });
  it("resolveName returns null when nothing resolves", async () => {
    const api: any = { retrieveMultipleRecords: vi.fn(), retrieveRecord: vi.fn(async () => { throw new Error("404"); }) };
    const svc = createRecordSearchService(api, meta);
    expect(await svc.resolveName(["account"], "g9")).toBeNull();
  });
  it("resolveName caches by GUID so retrieveRecord is called only once for repeated calls", async () => {
    const api: any = {
      retrieveMultipleRecords: vi.fn(),
      retrieveRecord: vi.fn(async () => ({ fullname: "Cached Name" })),
    };
    const svc = createRecordSearchService(api, meta);
    const first = await svc.resolveName(["contact"], "g1");
    const second = await svc.resolveName(["contact"], "g1");
    expect(first).toBe("Cached Name");
    expect(second).toBe("Cached Name");
    expect(api.retrieveRecord).toHaveBeenCalledTimes(1);
  });
});
