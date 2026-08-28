import { describe, it, expect } from "vitest";
import { parseLayoutColumns, parseSavedViews, type RawViewRow } from "../../src/editor/load/views";

const layout = JSON.stringify({ Rows: [{ Cells: [
  { Name: "name", Width: 300 }, { Name: "telephone1", Width: 150 }, { Name: "_ownerid_value", Width: 100 },
] }] });
const display = (n: string) => ({ name: "Account Name", telephone1: "Phone" } as Record<string, string>)[n] ?? n;

describe("parseLayoutColumns", () => {
  it("maps layoutjson cells to columns with display names, skipping _-prefixed cells", () => {
    expect(parseLayoutColumns(layout, display)).toEqual([
      { logicalName: "name", displayName: "Account Name", width: 300 },
      { logicalName: "telephone1", displayName: "Phone", width: 150 },
    ]);
  });
  it("returns [] for null or malformed layout", () => {
    expect(parseLayoutColumns(null, display)).toEqual([]);
    expect(parseLayoutColumns("{not json", display)).toEqual([]);
  });
});

describe("parseSavedViews", () => {
  it("drops rows without fetchxml and maps columns", () => {
    const rows: RawViewRow[] = [
      { id: "1", name: "Active Accounts", fetchXml: "<fetch/>", layoutjson: layout, isDefault: true, isPersonal: false },
      { id: "2", name: "Broken", fetchXml: "", layoutjson: null, isDefault: false, isPersonal: false },
    ];
    const views = parseSavedViews(rows, display);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: "1", name: "Active Accounts", isDefault: true, isPersonal: false });
    expect(views[0].columns.map((c) => c.logicalName)).toEqual(["name", "telephone1"]);
  });
});

import { createMetadataService } from "../../src/editor/metadata";

describe("MetadataService.views", () => {
  it("queries system + personal views and parses columns", async () => {
    const calls: string[] = [];
    const api: any = {
      getClientUrl: () => "",
      fetchJson: async (path: string) => {
        calls.push(path);
        if (path.startsWith("EntityDefinitions(LogicalName='account')/Attributes"))
          return { value: [{ LogicalName: "name", AttributeType: "String", DisplayName: { UserLocalizedLabel: { Label: "Account Name" } },
            IsValidForCreate: true, IsValidForUpdate: true, IsValidForRead: true, IsCustomAttribute: false }] };
        if (path.startsWith("savedqueries"))
          return { value: [{ savedqueryid: "s1", name: "Active Accounts", fetchxml: "<fetch/>",
            layoutjson: JSON.stringify({ Rows: [{ Cells: [{ Name: "name", Width: 300 }] }] }), isdefault: true }] };
        if (path.startsWith("userqueries"))
          return { value: [{ userqueryid: "u1", name: "My Accounts", fetchxml: "<fetch/>", layoutjson: null }] };
        return { value: [] };
      },
    };
    const svc = createMetadataService(api);
    const views = await svc.views("account");
    expect(views.map((v) => [v.id, v.name, v.isPersonal])).toEqual([
      ["s1", "Active Accounts", false], ["u1", "My Accounts", true],
    ]);
    expect(views[0].columns).toEqual([{ logicalName: "name", displayName: "Account Name", width: 300 }]);
    expect(calls.some((c) => c.includes("savedqueries") && c.includes("querytype eq 0"))).toBe(true);
  });
});
