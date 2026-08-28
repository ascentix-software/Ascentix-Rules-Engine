import { describe, it, expect } from "vitest";
import {
  mapRuleHeader, mapConditionRecord, mapActionRecord, mapTableConfig, mapLocalizedMessage,
} from "../../src/editor/load/mappers";
import { rawRule, rawCondition, rawAction, rawTableConfig } from "./fixtures";

describe("record mappers", () => {
  it("maps the rule header incl. new rule fields", () => {
    expect(mapRuleHeader(rawRule)).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Credit limit approver required",
      tableLogicalName: "account",
      statusCode: 1,
      etag: null,
      triggers: [1, 4],
      channels: [],
      effectiveFrom: null,
      effectiveTo: null,
      evaluationContext: 1,
      rootTableConfigId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      triggerColumns: ["sample_lineamount"],
    });
  });

  it("defaults triggerColumns to [] when asx_triggercolumns is blank/absent", () => {
    expect(mapRuleHeader({ ...rawRule, asx_triggercolumns: null }).triggerColumns).toEqual([]);
    expect(mapRuleHeader({ ...rawRule, asx_triggercolumns: "" }).triggerColumns).toEqual([]);
    const { asx_triggercolumns, ...withoutField } = rawRule;
    expect(mapRuleHeader(withoutField).triggerColumns).toEqual([]);
  });

  it("maps a field-comparison condition incl. table-config lookup", () => {
    const c = mapConditionRecord(rawCondition);
    expect(c.id).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
    expect(c.conditionType).toBe("FieldComparison");
    expect(c.comparisonColumn).toBe("creditlimit");
    expect(c.comparisonValue).toBe("10000");
    expect(c.tableConfigId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(c.comparisonOperator).toBe(5);
    expect(c.valueSource).toBe(1);
    expect(c.comparisonValueNodeId).toBeNull();
  });

  it("maps an Expression condition's expression field", () => {
    const c = mapConditionRecord({
      ...rawCondition, asx_conditiontype: 4, asx_comparisoncolumn: null,
      asx_conditionexpression: "{root.quantity} * {root.price}",
    });
    expect(c.conditionType).toBe("Expression");
    expect(c.expression).toBe("{root.quantity} * {root.price}");
  });

  it("defaults expression to null when absent", () => {
    expect(mapConditionRecord(rawCondition).expression).toBeNull();
  });

  it("maps an action incl. enum label", () => {
    const a = mapActionRecord(rawAction);
    expect(a.id).toBe("dddddddd-dddd-dddd-dddd-dddddddddddd");
    expect(a.actionType).toBe("SetRequired");
    expect(a.order).toBe(1);
    expect(a.targetColumn).toBe("creditlimitapprovedby");
    expect(a.targetNodeId).toBeNull();
  });

  it("maps a table-config ref", () => {
    expect(mapTableConfig(rawTableConfig)).toEqual({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: "Account (root)",
      tableLogicalName: "account",
      tableConfigType: "RootTable",
      parentTableConfigId: null,
      lookupColumnLogicalName: null,
      childLinkField: null,
      lookupTargetIdAttribute: null,
      etag: null,          // no @odata.etag on the fixture (see "child row versions" below)
    });
  });
});

describe("mapper extensions", () => {
  it("maps the rule ETag", () => {
    const h = mapRuleHeader({ ...rawRule, "@odata.etag": 'W/"123456"' });
    expect(h.etag).toBe('W/"123456"');
  });
  it("defaults etag to null when absent", () => {
    expect(mapRuleHeader(rawRule).etag).toBeNull();
  });
  it("maps the new action persisted fields", () => {
    const a = mapActionRecord({
      ...rawAction, asx_valuebool: true, asx_applyinversewhennotfired: false,
      asx_severity: 3, asx_isactive: true,
    });
    expect(a.value).toBe(true);
    expect(a.applyInverseWhenNotFired).toBe(false);
    expect(a.severity).toBe(3);
    expect(a.isActive).toBe(true);
  });
});

describe("localized messages", () => {
  it("maps a localized-message record", () => {
    expect(mapLocalizedMessage({
      asx_localizedmessageid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      asx_languagecode: 1036, asx_message: "Bonjour",
    })).toEqual({ id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", languageCode: 1036, message: "Bonjour", etag: null });
  });

  it("maps localized messages expanded under an action", () => {
    const a = mapActionRecord(rawAction);
    expect(a.localizedMessages).toEqual([
      { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", languageCode: 1036, message: "Bonjour", etag: null },
    ]);
  });
});

describe("mapTableConfig", () => {
  it("maps parent + lookup/child columns", () => {
    const tc = mapTableConfig({
      asx_tableconfigid: "n1", asx_name: "Customer (lookup)", asx_tablelogicalname: "sample_customer",
      asx_tableconfigtype: 2, _asx_parenttable_value: "root1",
      asx_lookupcolumnlogicalname: "sample_customerid", asx_childlinkfield: null,
    });
    expect(tc.parentTableConfigId).toBe("root1");
    expect(tc.lookupColumnLogicalName).toBe("sample_customerid");
    expect(tc.childLinkField).toBeNull();
    expect(tc.tableConfigType).toBe("LookupTable");
  });
  it("root node has null parent/columns", () => {
    const tc = mapTableConfig({ asx_tableconfigid: "r", asx_name: "Order", asx_tablelogicalname: "sample_order", asx_tableconfigtype: 1 });
    expect(tc.parentTableConfigId).toBeNull();
    expect(tc.lookupColumnLogicalName).toBeNull();
  });
});

describe("mapRuleHeader", () => {
  it("maps the root table config id", () => {
    const r = mapRuleHeader({ asx_ruleid: "rid", asx_name: "R", asx_tablelogicalname: "sample_order", _asx_roottableconfig_value: "root1" });
    expect(r.rootTableConfigId).toBe("root1");
  });
});

describe("mapTableConfig — lookupTargetIdAttribute", () => {
  it("maps asx_lookuptargetidattribute", () => {
    const tc = mapTableConfig({
      asx_tableconfigid: "n1", asx_name: "L1", asx_tablelogicalname: "perf_lookup1",
      asx_tableconfigtype: 2, asx_lookupcolumnlogicalname: "perf_lookup1id",
      asx_lookuptargetidattribute: "perf_lookup1id",
    });
    expect(tc.lookupTargetIdAttribute).toBe("perf_lookup1id");
  });
});
