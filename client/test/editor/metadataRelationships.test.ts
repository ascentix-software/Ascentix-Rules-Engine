import { describe, it, expect } from "vitest";
import { createMetadataService } from "../../src/editor/metadata";
import type { MetadataApi } from "../../src/editor/webapi";

function fakeApi(calls: string[]): MetadataApi {
  return {
    getClientUrl: () => "http://test",
    fetchJson: async (path: string) => {
      calls.push(path);
      if (path.includes("ManyToOneRelationships")) {
        return { value: [
          { SchemaName: "sample_order_customer", ReferencingAttribute: "sample_customerid", ReferencedEntity: "sample_customer" },
          { SchemaName: "owner_order", ReferencingAttribute: "ownerid", ReferencedEntity: "systemuser" }, // ownership noise
        ] };
      }
      if (path.includes("OneToManyRelationships")) {
        return { value: [
          { SchemaName: "order_orderline", ReferencingEntity: "sample_orderline", ReferencingAttribute: "sample_orderid" },
          { SchemaName: "order_asyncoperations", ReferencingEntity: "asyncoperation", ReferencingAttribute: "regardingobjectid" }, // system noise
        ] };
      }
      throw new Error("unexpected path " + path);
    },
  };
}

describe("metadata.relationships", () => {
  it("parses manyToOne and oneToMany, excluding ownership/system tables", async () => {
    const calls: string[] = [];
    const svc = createMetadataService(fakeApi(calls));
    const rels = await svc.relationships("sample_order");
    expect(rels.manyToOne).toEqual([
      { schemaName: "sample_order_customer", referencingAttribute: "sample_customerid", referencedEntity: "sample_customer" },
    ]);
    expect(rels.oneToMany).toEqual([
      { schemaName: "order_orderline", referencingEntity: "sample_orderline", referencingAttribute: "sample_orderid" },
    ]);
  });

  it("caches per table (one fetch pair per table)", async () => {
    const calls: string[] = [];
    const svc = createMetadataService(fakeApi(calls));
    await svc.relationships("sample_order");
    await svc.relationships("sample_order");
    expect(calls.length).toBe(2); // 2 endpoints, fetched once each
  });
});
