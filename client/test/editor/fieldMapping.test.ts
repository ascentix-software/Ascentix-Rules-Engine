import { describe, it, expect, beforeEach } from "vitest";
import {
  parseFieldMapping, serializeFieldMapping, emptyRow, resetRowKeys,
  validateRows, literalToEditorString, editorStringToLiteral, summarizeMapping,
} from "../../src/editor/model/fieldMapping";
import type { NodeFilterGroupModel, NodeFilterExists } from "../../src/editor/model/nodeFilter";

describe("parseFieldMapping", () => {
  beforeEach(() => resetRowKeys());

  it("returns empty rows for null/blank input", () => {
    expect(parseFieldMapping(null)).toEqual({ ok: true, rows: [] });
    expect(parseFieldMapping("  ")).toEqual({ ok: true, rows: [] });
  });

  it("parses the three known sources", () => {
    const json = JSON.stringify([
      { target: "subject", source: "literal", value: "Follow up" },
      { target: "regardingid", source: "root", column: "accountid" },
      { target: "ownerid", source: "node", node: "a1b2c3d4-0000-0000-0000-000000000001", column: "manager" },
    ]);
    const r = parseFieldMapping(json);
    if (!r.ok) throw new Error(r.error);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({ target: "subject", source: "literal", value: "Follow up" });
    expect(r.rows[1]).toMatchObject({ target: "regardingid", source: "root", column: "accountid" });
    expect(r.rows[2]).toMatchObject({
      target: "ownerid", source: "node",
      node: "a1b2c3d4-0000-0000-0000-000000000001", column: "manager",
    });
  });

  it("captures the lookup table for lookup literals", () => {
    const json = JSON.stringify([
      { target: "customerid", source: "literal", value: { id: "11111111-0000-0000-0000-000000000001", logicalname: "account" } },
    ]);
    const r = parseFieldMapping(json);
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0].lookupTable).toBe("account");
  });

  it("keeps a literal with a missing value as null", () => {
    const r = parseFieldMapping(JSON.stringify([{ target: "subject", source: "literal" }]));
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0].value).toBeNull();
  });

  it("classifies unrecognized sources as unknown and preserves the entry", () => {
    const entry = { target: "subject", source: "futuretype", data: "unknown" };
    const r = parseFieldMapping(JSON.stringify([entry]));
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0].source).toBe("unknown");
    expect(r.rows[0].target).toBe("subject");
    expect(r.rows[0].raw).toEqual(entry);
  });

  it("fails on invalid JSON, non-array JSON, and non-object entries", () => {
    expect(parseFieldMapping("{nope").ok).toBe(false);
    expect(parseFieldMapping('{"a":1}').ok).toBe(false);
    expect(parseFieldMapping("[1,2]").ok).toBe(false);
  });

  it("gives every row a unique key", () => {
    const r = parseFieldMapping(JSON.stringify([
      { target: "a", source: "root", column: "x" },
      { target: "b", source: "root", column: "y" },
    ]));
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0].key).not.toBe(r.rows[1].key);
  });
});

describe("serializeFieldMapping", () => {
  beforeEach(() => resetRowKeys());

  it("returns null for no rows", () => {
    expect(serializeFieldMapping([])).toBeNull();
  });

  it("round-trips all three sources plus unknown entries verbatim", () => {
    const original = [
      { target: "subject", source: "literal", value: "Follow up" },
      { target: "statuscode", source: "literal", value: 2 },
      { target: "isescalated", source: "literal", value: true },
      { target: "customerid", source: "literal", value: { id: "11111111-0000-0000-0000-000000000001", logicalname: "account" } },
      { target: "asx_tags", source: "literal", value: [1, 3] },
      { target: "regardingid", source: "root", column: "accountid" },
      { target: "ownerid", source: "node", node: "a1b2c3d4-0000-0000-0000-000000000001", column: "manager" },
      { target: "followupby", source: "dateexpr", anchor: { kind: "now" }, op: "add", amount: 3, unit: "days" },
    ];
    const parsed = parseFieldMapping(JSON.stringify(original));
    if (!parsed.ok) throw new Error(parsed.error);
    const out = serializeFieldMapping(parsed.rows);
    expect(JSON.parse(out!)).toEqual(original);
  });

  it("serializes a literal row whose value is null with an explicit null", () => {
    const row = { ...emptyRow(), target: "subject", source: "literal" as const };
    expect(JSON.parse(serializeFieldMapping([row])!)).toEqual([
      { target: "subject", source: "literal", value: null },
    ]);
  });
});

describe("validateRows", () => {
  beforeEach(() => resetRowKeys());
  const lit = (target: string | null, value: unknown = "x") =>
    ({ ...emptyRow(), target, source: "literal" as const, value });

  it("accepts a complete literal/root/node set", () => {
    const rows = [
      lit("subject"),
      { ...emptyRow(), target: "a", source: "root" as const, column: "accountid" },
      { ...emptyRow(), target: "b", source: "node" as const,
        node: "a1b2c3d4-0000-0000-0000-000000000002", column: "manager" },
    ];
    expect(validateRows(rows)).toEqual([]);
  });

  it("flags a missing target column", () => {
    expect(validateRows([lit(null)])).toEqual(["Row 1: choose a column."]);
  });

  it("flags duplicate targets once", () => {
    const errs = validateRows([lit("subject"), lit("subject"), lit("subject")]);
    expect(errs).toEqual(["Column 'subject' is set more than once."]);
  });

  it("flags incomplete root and node rows", () => {
    const rows = [
      { ...emptyRow(), target: "a", source: "root" as const },
      { ...emptyRow(), target: "b", source: "node" as const },
    ];
    expect(validateRows(rows)).toEqual([
      "a: choose a source column.",
      "b: choose a related node.",
      "b: choose a source column.",
    ]);
  });

  it("flags a lookup literal missing its target table", () => {
    const rows = [lit("customerid", { id: "11111111-0000-0000-0000-000000000001", logicalname: "" })];
    expect(validateRows(rows)).toEqual(["customerid: choose the lookup's target table record again."]);
  });

  it("skips unknown-source rows", () => {
    const row = { ...emptyRow(), target: "subject", source: "unknown" as const, raw: { target: "subject", source: "template" } };
    expect(validateRows([row])).toEqual([]);
  });

  it("accepts a node row whose node id is a saved GUID", () => {
    const rows = [
      { ...emptyRow(), target: "ownerid", source: "node" as const,
        node: "a1b2c3d4-0000-0000-0000-000000000001", column: "manager" },
    ];
    expect(validateRows(rows)).toEqual([]);
  });

  it("rejects a node row whose node id is an unsaved temp id", () => {
    const rows = [
      { ...emptyRow(), target: "ownerid", source: "node" as const, node: "new-3", column: "manager" },
    ];
    expect(validateRows(rows)).toEqual([
      "ownerid: the related node must be saved before it can be referenced.",
    ]);
  });

  it("flags a mathexpr aggregate whose node is single-cardinality (not a collection)", () => {
    const rootId = "a1b2c3d4-0000-0000-0000-000000000010";
    const childId = "a1b2c3d4-0000-0000-0000-000000000011"; // ChildTable, a collection.
    const lookupId = "a1b2c3d4-0000-0000-0000-000000000012"; // LookupTable, single-cardinality.
    const tableConfigs = {
      [rootId]: { id: rootId, name: "Root", tableLogicalName: "root", tableConfigType: "RootTable" as const,
        parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null },
      [childId]: { id: childId, name: "Line items", tableLogicalName: "lineitem", tableConfigType: "ChildTable" as const,
        parentTableConfigId: rootId, lookupColumnLogicalName: null, childLinkField: "parentid", lookupTargetIdAttribute: null },
      [lookupId]: { id: lookupId, name: "Owner", tableLogicalName: "owner", tableConfigType: "LookupTable" as const,
        parentTableConfigId: rootId, lookupColumnLogicalName: "ownerid", childLinkField: null, lookupTargetIdAttribute: null },
    };
    const base = { ...emptyRow(), target: "amount", source: "mathexpr" as const };
    expect(validateRows([{ ...base, expression: `sum(node:${childId}.amount)` }], tableConfigs)).toEqual([]);
    expect(validateRows([{ ...base, expression: `sum(node:${lookupId}.amount)` }], tableConfigs)).toEqual([
      "amount: an aggregate must reference a related collection, not a single record.",
    ]);
  });
});

describe("literalToEditorString / editorStringToLiteral", () => {
  it("converts literals to the picker string form", () => {
    expect(literalToEditorString(null)).toBe("");
    expect(literalToEditorString("hi")).toBe("hi");
    expect(literalToEditorString(2)).toBe("2");
    expect(literalToEditorString(true)).toBe("true");
    expect(literalToEditorString([1, 3])).toBe("1,3");
    expect(literalToEditorString({ id: "abc", logicalname: "account" })).toBe("abc");
  });

  it("converts picker strings back per column kind", () => {
    expect(editorStringToLiteral("", "text", null)).toBeNull();
    expect(editorStringToLiteral("hi", "text", null)).toBe("hi");
    expect(editorStringToLiteral("2", "optionset", null)).toBe(2);
    expect(editorStringToLiteral("2.5", "number", null)).toBe(2.5);
    expect(editorStringToLiteral("true", "boolean", null)).toBe(true);
    expect(editorStringToLiteral("false", "boolean", null)).toBe(false);
    expect(editorStringToLiteral("1, 3", "multiselect", null)).toEqual([1, 3]);
    expect(editorStringToLiteral("abc", "lookup", "account")).toEqual({ id: "abc", logicalname: "account" });
    expect(editorStringToLiteral("2026-07-05T00:00:00Z", "datetime", null)).toBe("2026-07-05T00:00:00Z");
  });

  it("keeps a non-numeric string for number kinds so validation can catch it later", () => {
    expect(editorStringToLiteral("abc", "number", null)).toBe("abc");
  });

  it("keeps the raw string for multiselect input with non-integer tokens", () => {
    expect(editorStringToLiteral("1,abc", "multiselect", null)).toBe("1,abc");
    expect(editorStringToLiteral("1.5,2", "multiselect", null)).toBe("1.5,2");
  });
});

describe("summarizeMapping", () => {
  it("summarizes counts and first targets", () => {
    expect(summarizeMapping(null)).toBe("No columns set.");
    const json = JSON.stringify([
      { target: "subject", source: "literal", value: "x" },
      { target: "ownerid", source: "root", column: "ownerid" },
      { target: "a", source: "root", column: "b" },
      { target: "c", source: "root", column: "d" },
    ]);
    expect(summarizeMapping(json)).toBe("4 columns set: subject, ownerid, a +1 more");
    expect(summarizeMapping(JSON.stringify([{ target: "subject", source: "literal", value: "x" }])))
      .toBe("1 column set: subject");
  });

  it("uses the display-name resolver when provided", () => {
    const json = JSON.stringify([{ target: "subject", source: "literal", value: "x" }]);
    expect(summarizeMapping(json, (l) => (l === "subject" ? "Subject" : l)))
      .toBe("1 column set: Subject");
  });

  it("reports unparseable JSON", () => {
    expect(summarizeMapping("{nope")).toBe("Existing field mapping could not be read. Open the editor to fix it.");
  });
});

describe("ref source", () => {
  beforeEach(() => resetRowKeys());
  const ROOT = "a1b2c3d4-0000-0000-0000-0000000000aa";

  it("parses a ref entry, capturing the node id", () => {
    const r = parseFieldMapping(JSON.stringify([{ target: "objectid", source: "ref", node: ROOT }]));
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0]).toMatchObject({ target: "objectid", source: "ref", node: ROOT });
  });

  it("round-trips a ref entry", () => {
    const original = [{ target: "objectid", source: "ref", node: ROOT }];
    const parsed = parseFieldMapping(JSON.stringify(original));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(JSON.parse(serializeFieldMapping(parsed.rows)!)).toEqual(original);
  });

  it("validates ref rows", () => {
    const base = { ...emptyRow(), target: "objectid", source: "ref" as const };
    expect(validateRows([{ ...base, node: null }])).toEqual(["objectid: choose a record."]);
    expect(validateRows([{ ...base, node: "new-3" }]))
      .toEqual(["objectid: the related node must be saved before it can be referenced."]);
    expect(validateRows([{ ...base, node: ROOT }])).toEqual([]);
  });
});

describe("template and dateexpr rows", () => {
  beforeEach(() => resetRowKeys());
  const NODE = "a1b2c3d4-0000-0000-0000-000000000001";

  it("round-trips template and dateexpr entries", () => {
    const original = [
      { target: "subject", source: "template", template: `Hi {root.name} — {node:${NODE}.fullname}` },
      { target: "followupby", source: "dateexpr", anchor: { kind: "now" }, op: "add", amount: 3, unit: "days" },
      { target: "duedate", source: "dateexpr",
        anchor: { kind: "field", node: NODE, column: "createdon" }, op: "subtract", amount: 2, unit: "weeks" },
    ];
    const parsed = parseFieldMapping(JSON.stringify(original));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.rows[0]).toMatchObject({ source: "template", template: original[0].template });
    expect(parsed.rows[1]).toMatchObject({ source: "dateexpr", anchorKind: "now", op: "add", amount: 3, unit: "days" });
    expect(parsed.rows[2]).toMatchObject({ anchorKind: "field", anchorNode: NODE, anchorColumn: "createdon" });
    expect(JSON.parse(serializeFieldMapping(parsed.rows)!)).toEqual(original);
  });

  it("round-trips a root field anchor (node null)", () => {
    const original = [{ target: "duedate", source: "dateexpr",
      anchor: { kind: "field", node: null, column: "createdon" }, op: "add", amount: 1, unit: "months" }];
    const parsed = parseFieldMapping(JSON.stringify(original));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.rows[0].anchorNode).toBeNull();
    expect(JSON.parse(serializeFieldMapping(parsed.rows)!)).toEqual(original);
  });

  it("validates template rows", () => {
    const base = { ...emptyRow(), target: "subject", source: "template" as const };
    expect(validateRows([{ ...base, template: null }])).toEqual(["subject: enter template text."]);
    expect(validateRows([{ ...base, template: "open {" }])[0]).toMatch(/^subject: /);
    expect(validateRows([{ ...base, template: "{node:new-3.fullname}" }]))
      .toEqual(["subject: the related node must be saved before it can be referenced."]);
    expect(validateRows([{ ...base, template: `ok {node:${NODE}.fullname}` }])).toEqual([]);
    expect(validateRows([{ ...base, template: "plain text only" }])).toEqual([]);
  });

  it("validates dateexpr rows", () => {
    const base = { ...emptyRow(), target: "duedate", source: "dateexpr" as const };
    const good = { ...base, anchorKind: "now" as const, op: "add" as const, amount: 3, unit: "days" as const };
    expect(validateRows([good])).toEqual([]);
    expect(validateRows([{ ...good, anchorKind: null }])).toContain("duedate: choose a date anchor.");
    expect(validateRows([{ ...good, anchorKind: "field" }])).toContain("duedate: choose the anchor date column.");
    expect(validateRows([{ ...good, anchorKind: "field", anchorColumn: "createdon", anchorNode: "new-2" }]))
      .toContain("duedate: the related node must be saved before it can be referenced.");
    expect(validateRows([{ ...good, op: null }])).toContain("duedate: choose add or subtract.");
    expect(validateRows([{ ...good, amount: 0 }])).toContain("duedate: amount must be a positive whole number.");
    expect(validateRows([{ ...good, amount: 2.5 }])).toContain("duedate: amount must be a positive whole number.");
    expect(validateRows([{ ...good, unit: null }])).toContain("duedate: choose a unit.");
  });

  it("round-trips a mathexpr entry", () => {
    const json = JSON.stringify([{ target: "amount", source: "mathexpr", expression: "{root.qty} * 2" }]);
    const parsed = parseFieldMapping(json);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.rows[0].source).toBe("mathexpr");
      expect(parsed.rows[0].expression).toBe("{root.qty} * 2");
      expect(serializeFieldMapping(parsed.rows)).toBe(json);
    }
  });

  it("flags a mathexpr row with a malformed expression", () => {
    const rows = parseFieldMapping(
      JSON.stringify([{ target: "amount", source: "mathexpr", expression: "1 +" }]));
    expect(rows.ok).toBe(true);
    if (rows.ok) expect(validateRows(rows.rows).length).toBeGreaterThan(0);
  });
});

describe("mathexpr aggregate filters", () => {
  beforeEach(() => resetRowKeys());
  const NODE = "a1b2c3d4-0000-0000-0000-000000000001";
  const filterGroup: NodeFilterGroupModel = {
    kind: "group", id: "g", op: "and", rules: [
      { kind: "rule", id: "r", column: "statuscode", operator: 1, valueSource: 1,
        value: "1", valueNodeId: null, valueColumn: null },
    ],
  };

  it("parses a mathexpr entry's filters map", () => {
    const json = JSON.stringify([{
      target: "amount", source: "mathexpr",
      expression: `sum(node:${NODE}.amount filter:f1)`,
      filters: { f1: filterGroup },
    }]);
    const r = parseFieldMapping(json);
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0].filters).toEqual({ f1: filterGroup });
  });

  it("defaults filters to null when absent", () => {
    const json = JSON.stringify([{ target: "amount", source: "mathexpr", expression: "1 + 1" }]);
    const r = parseFieldMapping(json);
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0].filters).toBeNull();
  });

  it("round-trips filters through serialize", () => {
    const original = [{
      target: "amount", source: "mathexpr",
      expression: `sum(node:${NODE}.amount filter:f1)`,
      filters: { f1: filterGroup },
    }];
    const parsed = parseFieldMapping(JSON.stringify(original));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(JSON.parse(serializeFieldMapping(parsed.rows)!)).toEqual(original);
  });

  it("omits filters from serialized output when null or empty", () => {
    const nullRow = { ...emptyRow(), target: "amount", source: "mathexpr" as const,
      expression: "1 + 1", filters: null };
    expect(JSON.parse(serializeFieldMapping([nullRow])!)).toEqual([
      { target: "amount", source: "mathexpr", expression: "1 + 1" },
    ]);
    const emptyObjRow = { ...emptyRow(), target: "amount", source: "mathexpr" as const,
      expression: "1 + 1", filters: {} };
    expect(JSON.parse(serializeFieldMapping([emptyObjRow])!)).toEqual([
      { target: "amount", source: "mathexpr", expression: "1 + 1" },
    ]);
  });

  it("flags a filter key referenced by the expression but missing from filters", () => {
    const base = { ...emptyRow(), target: "amount", source: "mathexpr" as const,
      expression: `sum(node:${NODE}.amount filter:f1)`, filters: null };
    expect(validateRows([base])).toEqual([
      "amount: filter 'f1' is referenced but not defined.",
    ]);
  });

  it("flags an orphan filters entry not referenced by the expression", () => {
    const base = { ...emptyRow(), target: "amount", source: "mathexpr" as const,
      expression: `sum(node:${NODE}.amount)`, filters: { f1: filterGroup } };
    expect(validateRows([base])).toEqual([
      "amount: filter 'f1' is defined but not used.",
    ]);
  });

  it("accepts a mathexpr row whose filter keys match exactly", () => {
    const base = { ...emptyRow(), target: "amount", source: "mathexpr" as const,
      expression: `sum(node:${NODE}.amount filter:f1)`, filters: { f1: filterGroup } };
    expect(validateRows([base])).toEqual([]);
  });

  it("round-trips an exists node nested within a filter group, preserving kind/collectionNodeId/minCount/maxCount/sub", () => {
    const existsSub: NodeFilterGroupModel = {
      kind: "group", id: "sub1", op: "and", rules: [
        { kind: "rule", id: "r1", column: "statuscode", operator: 1, valueSource: 1,
          value: "1", valueNodeId: null, valueColumn: null },
      ],
    };
    const existsNodeModel: NodeFilterExists = {
      kind: "exists", id: "e1", collectionNodeId: NODE, minCount: 1, maxCount: null, sub: existsSub,
    };
    const existsFilterGroup: NodeFilterGroupModel = {
      kind: "group", id: "g2", op: "and", rules: [existsNodeModel],
    };
    const original = [{
      target: "amount", source: "mathexpr",
      expression: `sum(node:${NODE}.amount filter:f1)`,
      filters: { f1: existsFilterGroup },
    }];

    // parse
    const parsed = parseFieldMapping(JSON.stringify(original));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.rows[0].filters).toEqual({ f1: existsFilterGroup });

    // serialize
    const serialized = serializeFieldMapping(parsed.rows);
    const roundTripped = JSON.parse(serialized!);
    expect(roundTripped).toEqual(original);
    const existsNode = roundTripped[0].filters.f1.rules[0];
    expect(existsNode).toEqual(existsNodeModel);

    // parse again: a second round-trip must be stable
    const reparsed = parseFieldMapping(serialized);
    if (!reparsed.ok) throw new Error(reparsed.error);
    expect(reparsed.rows[0].filters).toEqual({ f1: existsFilterGroup });
  });
});
