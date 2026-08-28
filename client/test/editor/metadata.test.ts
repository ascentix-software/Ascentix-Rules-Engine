import { describe, it, expect, vi } from "vitest";
import { createMetadataService, columnsForContext } from "../../src/editor/metadata";
import type { MetadataApi } from "../../src/editor/webapi";

function fakeApi(responses: Record<string, any>): MetadataApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getClientUrl: () => "https://org",
    fetchJson: vi.fn(async (path: string) => {
      calls.push(path);
      const key = Object.keys(responses).find((k) => path.startsWith(k));
      if (!key) throw new Error("unexpected path " + path);
      return responses[key];
    }),
  } as any;
}

const tablesResp = {
  value: [
    { LogicalName: "account", EntitySetName: "accounts", DisplayName: { UserLocalizedLabel: { Label: "Account" } } },
  ],
};
const colsResp = {
  value: [
    { LogicalName: "name", AttributeType: "String", IsValidForCreate: { Value: true }, IsValidForUpdate: { Value: true }, IsValidForRead: { Value: true }, DisplayName: { UserLocalizedLabel: { Label: "Name" } } },
    { LogicalName: "createdon", AttributeType: "DateTime", IsValidForCreate: { Value: false }, IsValidForUpdate: { Value: false }, IsValidForRead: { Value: true }, DisplayName: { UserLocalizedLabel: { Label: "Created On" } } },
  ],
};
// Live shape: with $select on the managed-property fields, the Web API returns
// them as BARE BOOLEANS (not { Value } ManagedProperty objects).
const colsRespBare = {
  value: [
    { LogicalName: "name", AttributeType: "String", IsValidForCreate: true, IsValidForUpdate: true, IsValidForRead: true, DisplayName: { UserLocalizedLabel: { Label: "Name" } } },
    { LogicalName: "createdon", AttributeType: "DateTime", IsValidForCreate: false, IsValidForUpdate: false, IsValidForRead: true, DisplayName: { UserLocalizedLabel: { Label: "Created On" } } },
  ],
};
describe("metadata service", () => {
  it("maps + caches tables", async () => {
    const api = fakeApi({ "EntityDefinitions?": tablesResp });
    const svc = createMetadataService(api);
    const t1 = await svc.tables();
    const t2 = await svc.tables();
    expect(t1[0]).toEqual({ logicalName: "account", displayName: "Account", entitySetName: "accounts", isCustom: false });
    expect(api.calls.length).toBe(1); // cached on the second call
    expect(t2).toBe(t1);
  });

  it("maps + caches columns per table", async () => {
    const api = fakeApi({ "EntityDefinitions(LogicalName='account')/Attributes": colsResp });
    const svc = createMetadataService(api);
    const cols = await svc.columns("account");
    await svc.columns("account");
    expect(cols.map((c) => c.logicalName)).toEqual(["name", "createdon"]);
    expect(cols[0].isValidForCreate).toBe(true);
    expect(api.calls.length).toBe(1);
  });

  it("maps columns when the API returns bare-boolean managed properties", async () => {
    const api = fakeApi({ "EntityDefinitions(LogicalName='account')/Attributes": colsRespBare });
    const svc = createMetadataService(api);
    const cols = await svc.columns("account");
    // Real $select-projected shape (bare booleans) must map to true, not false.
    expect(cols[0]).toMatchObject({ logicalName: "name", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true });
    expect(cols[1]).toMatchObject({ logicalName: "createdon", isValidForCreate: false, isValidForUpdate: false, isValidForRead: true });
    // The reported bug: read-context columns came back empty because every flag was false.
    expect(columnsForContext(cols, "read").map((c) => c.logicalName)).toEqual(["name", "createdon"]);
  });

  it("filters columns by context", () => {
    const cols = [
      { logicalName: "name", displayName: "Name", attributeType: "String", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
      { logicalName: "createdon", displayName: "Created On", attributeType: "DateTime", isValidForCreate: false, isValidForUpdate: false, isValidForRead: true, isCustom: false },
    ];
    expect(columnsForContext(cols, "create").map((c) => c.logicalName)).toEqual(["name"]);
    expect(columnsForContext(cols, "read").map((c) => c.logicalName)).toEqual(["name", "createdon"]);
  });

  it("maps option-set options via the type-aware cast (Status)", async () => {
    const colsForOpt = { value: [
      { LogicalName: "statuscode", AttributeType: "Status", IsValidForCreate: true, IsValidForUpdate: true, IsValidForRead: true, IsCustomAttribute: false, DisplayName: { UserLocalizedLabel: { Label: "Status Reason" } } },
    ] };
    const optResp = { OptionSet: { Options: [{ Value: 1, Label: { UserLocalizedLabel: { Label: "Active" } } }] } };
    const api = fakeApi({
      "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='statuscode')/Microsoft.Dynamics.CRM.StatusAttributeMetadata": optResp,
      "EntityDefinitions(LogicalName='account')/Attributes": colsForOpt,
    });
    const svc = createMetadataService(api);
    const opts = await svc.optionSet("account", "statuscode");
    expect(opts).toEqual([{ value: 1, label: "Active" }]);
    // Confirms the Status cast path was used.
    expect(api.calls.some((c) => c.includes("StatusAttributeMetadata"))).toBe(true);
  });

  it("maps option-set options via the type-aware cast (State)", async () => {
    const colsForOpt = { value: [
      { LogicalName: "statecode", AttributeType: "State", IsValidForCreate: true, IsValidForUpdate: true, IsValidForRead: true, IsCustomAttribute: false, DisplayName: { UserLocalizedLabel: { Label: "Status" } } },
    ] };
    const optResp = { OptionSet: { Options: [{ Value: 0, Label: { UserLocalizedLabel: { Label: "Active" } } }] } };
    const api = fakeApi({
      "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='statecode')/Microsoft.Dynamics.CRM.StateAttributeMetadata": optResp,
      "EntityDefinitions(LogicalName='account')/Attributes": colsForOpt,
    });
    const svc = createMetadataService(api);
    const opts = await svc.optionSet("account", "statecode");
    expect(opts).toEqual([{ value: 0, label: "Active" }]);
    // Confirms the State cast path was used.
    expect(api.calls.some((c) => c.includes("StateAttributeMetadata"))).toBe(true);
  });

  it("uses the Picklist cast for Picklist columns and MultiSelect for Virtual", async () => {
    const colsForOpt = { value: [
      { LogicalName: "asx_rating", AttributeType: "Picklist", IsValidForRead: true, IsCustomAttribute: true, DisplayName: { UserLocalizedLabel: { Label: "Rating" } } },
      { LogicalName: "asx_tags", AttributeType: "Virtual", IsValidForRead: true, IsCustomAttribute: true, DisplayName: { UserLocalizedLabel: { Label: "Tags" } } },
    ] };
    const optResp = { OptionSet: { Options: [{ Value: 5, Label: { UserLocalizedLabel: { Label: "Hot" } } }] } };
    const api = fakeApi({
      "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='asx_rating')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata": optResp,
      "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='asx_tags')/Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata": optResp,
      "EntityDefinitions(LogicalName='account')/Attributes": colsForOpt,
    });
    const svc = createMetadataService(api);
    expect(await svc.optionSet("account", "asx_rating")).toEqual([{ value: 5, label: "Hot" }]);
    expect(await svc.optionSet("account", "asx_tags")).toEqual([{ value: 5, label: "Hot" }]);
  });

  it("returns [] for a non-optionset column", async () => {
    const colsForOpt = { value: [
      { LogicalName: "name", AttributeType: "String", IsValidForRead: true, IsCustomAttribute: false, DisplayName: { UserLocalizedLabel: { Label: "Name" } } },
    ] };
    const api = fakeApi({ "EntityDefinitions(LogicalName='account')/Attributes": colsForOpt });
    const svc = createMetadataService(api);
    expect(await svc.optionSet("account", "name")).toEqual([]);
  });

  it("maps + caches a global option set with user-localized labels", async () => {
    const globalResp = {
      Options: [
        { Value: 1, Label: { UserLocalizedLabel: { Label: "Field Comparison" } } },
        { Value: 2, Label: { UserLocalizedLabel: { Label: "Row Count" } } },
      ],
    };
    const api = fakeApi({ "GlobalOptionSetDefinitions(Name='asx_conditiontype')": globalResp });
    const svc = createMetadataService(api);
    const opts = await svc.globalOptionSet("asx_conditiontype");
    await svc.globalOptionSet("asx_conditiontype");
    expect(opts).toEqual([
      { value: 1, label: "Field Comparison" },
      { value: 2, label: "Row Count" },
    ]);
    expect(api.calls.length).toBe(1); // cached on the second call
  });

  it("maps primary name/id attributes on tables", async () => {
    const resp = { value: [{ LogicalName: "account", EntitySetName: "accounts",
      DisplayName: { UserLocalizedLabel: { Label: "Account" } },
      PrimaryNameAttribute: "name", PrimaryIdAttribute: "accountid" }] };
    const api = fakeApi({ "EntityDefinitions?": resp });
    const svc = createMetadataService(api);
    const t = await svc.tables();
    expect(t[0]).toMatchObject({ primaryNameAttribute: "name", primaryIdAttribute: "accountid" });
  });

  it("maps isCustom on columns (bare boolean and ManagedProperty shapes)", async () => {
    const resp = { value: [
      { LogicalName: "asx_x", AttributeType: "String", IsValidForCreate: true, IsValidForUpdate: true, IsValidForRead: true, IsCustomAttribute: true, DisplayName: { UserLocalizedLabel: { Label: "X" } } },
      { LogicalName: "name", AttributeType: "String", IsValidForCreate: true, IsValidForUpdate: true, IsValidForRead: true, IsCustomAttribute: { Value: false }, DisplayName: { UserLocalizedLabel: { Label: "Name" } } },
    ] };
    const api = fakeApi({ "EntityDefinitions(LogicalName='account')/Attributes": resp });
    const svc = createMetadataService(api);
    const cols = await svc.columns("account");
    expect(cols.find((c) => c.logicalName === "asx_x")!.isCustom).toBe(true);
    expect(cols.find((c) => c.logicalName === "name")!.isCustom).toBe(false);
  });

  it("reads lookup targets", async () => {
    const resp = { Targets: ["account", "contact"] };
    const api = fakeApi({
      "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='primarycontactid')/Microsoft.Dynamics.CRM.LookupAttributeMetadata": resp,
    });
    const svc = createMetadataService(api);
    expect(await svc.lookupTargets("account", "primarycontactid")).toEqual(["account", "contact"]);
  });

  it("reads localized boolean true/false labels with fallbacks", async () => {
    const resp = { OptionSet: {
      TrueOption: { Label: { UserLocalizedLabel: { Label: "Active" } } },
      FalseOption: { Label: { UserLocalizedLabel: { Label: "Inactive" } } },
    } };
    const api = fakeApi({
      "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='asx_flag')/Microsoft.Dynamics.CRM.BooleanAttributeMetadata": resp,
    });
    const svc = createMetadataService(api);
    expect(await svc.booleanLabels("account", "asx_flag")).toEqual({ trueLabel: "Active", falseLabel: "Inactive" });

    const empty = fakeApi({
      "EntityDefinitions(LogicalName='account')/Attributes(LogicalName='asx_flag')/Microsoft.Dynamics.CRM.BooleanAttributeMetadata": {},
    });
    expect(await createMetadataService(empty).booleanLabels("account", "asx_flag")).toEqual({ trueLabel: "True", falseLabel: "False" });
  });
});
