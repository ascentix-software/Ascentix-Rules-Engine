import { describe, it, expect, vi } from "vitest";
import { createRecordSearchService } from "../../src/editor/records";

const meta = {
  tables: async () => [
    { logicalName: "account", displayName: "Account", entitySetName: "accounts",
      primaryNameAttribute: "name", primaryIdAttribute: "accountid", isCustom: false },
  ],
} as any;

describe("queryByFetchXml", () => {
  it("runs the fetchxml and maps id/name/entity", async () => {
    const api: any = {
      retrieveMultipleRecords: vi.fn(async () => ({
        entities: [{ accountid: "g1", name: "Acme", telephone1: "555" }],
      })),
    };
    const svc = createRecordSearchService(api, meta);
    const rows = await svc.queryByFetchXml("account", "<fetch><entity name='account'/></fetch>");
    expect(rows).toEqual([{ id: "g1", name: "Acme", entity: { accountid: "g1", name: "Acme", telephone1: "555" } }]);
    expect(api.retrieveMultipleRecords).toHaveBeenCalledWith(
      "account", "?fetchXml=" + encodeURIComponent("<fetch><entity name='account'/></fetch>"));
  });
  it("falls back to the id when the primary name is absent", async () => {
    const api: any = { retrieveMultipleRecords: vi.fn(async () => ({ entities: [{ accountid: "g2" }] })) };
    const svc = createRecordSearchService(api, meta);
    const rows = await svc.queryByFetchXml("account", "<fetch/>");
    expect(rows[0]).toEqual({ id: "g2", name: "g2", entity: { accountid: "g2" } });
  });
});
