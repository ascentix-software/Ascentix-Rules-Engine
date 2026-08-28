import { describe, it, expect } from "vitest";
import { buildRecordJson } from "../src/recordJson";
import { createMockXrm } from "./mockXrm";

function xrmWith(attrs: Record<string, { type: string; value: unknown }>) {
  return createMockXrm({ tableLogicalName: "account", recordId: null, attributes: attrs });
}

describe("buildRecordJson", () => {
  it("encodes string, boolean, and integer", () => {
    const xrm = xrmWith({
      name: { type: "string", value: "Acme" },
      donotemail: { type: "boolean", value: true },
      numberofemployees: { type: "integer", value: 50 },
    });
    expect(buildRecordJson(xrm, ["name", "donotemail", "numberofemployees"]))
      .toEqual({ name: "Acme", donotemail: true, numberofemployees: 50 });
  });

  it("encodes money/decimal/double as numbers", () => {
    const xrm = xrmWith({ revenue: { type: "money", value: 123.45 } });
    expect(buildRecordJson(xrm, ["revenue"])).toEqual({ revenue: 123.45 });
  });

  it("encodes a lookup as {id, logicalname} with braces stripped", () => {
    const xrm = xrmWith({
      primarycontactid: { type: "lookup", value: [{ id: "{ABC}", entityType: "contact", name: "Bob" }] },
    });
    expect(buildRecordJson(xrm, ["primarycontactid"]))
      .toEqual({ primarycontactid: { id: "ABC", logicalname: "contact" } });
  });

  it("encodes an empty lookup as null", () => {
    const xrm = xrmWith({ primarycontactid: { type: "lookup", value: null } });
    expect(buildRecordJson(xrm, ["primarycontactid"])).toEqual({ primarycontactid: null });
  });

  it("encodes a multiselect optionset as an int array", () => {
    const xrm = xrmWith({ asx_categories: { type: "multiselectoptionset", value: [1, 2, 3] } });
    expect(buildRecordJson(xrm, ["asx_categories"])).toEqual({ asx_categories: [1, 2, 3] });
  });

  it("encodes a single optionset as an int", () => {
    const xrm = xrmWith({ statuscode: { type: "optionset", value: 1 } });
    expect(buildRecordJson(xrm, ["statuscode"])).toEqual({ statuscode: 1 });
  });

  it("encodes datetime as an ISO-8601 string", () => {
    const d = new Date(Date.UTC(2026, 5, 18, 12, 0, 0));
    const xrm = xrmWith({ createdon: { type: "datetime", value: d } });
    expect(buildRecordJson(xrm, ["createdon"])).toEqual({ createdon: d.toISOString() });
  });

  it("encodes an on-form cleared field as null", () => {
    const xrm = xrmWith({ name: { type: "string", value: null } });
    expect(buildRecordJson(xrm, ["name"])).toEqual({ name: null });
  });

  it("omits a column that is not on the form", () => {
    const xrm = xrmWith({ name: { type: "string", value: "Acme" } });
    // "creditlimit" is not in the attribute set → not on the form layout → omitted
    expect(buildRecordJson(xrm, ["name", "creditlimit"])).toEqual({ name: "Acme" });
  });
});
