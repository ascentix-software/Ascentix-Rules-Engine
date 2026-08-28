import { describe, it, expect } from "vitest";
import { hintIssues } from "../../src/editor/validation";
import type { RuleGraph, ConditionGroupNode, ConditionNode, ActionNode, TableConfigRef } from "../../src/editor/model/types";
import type { NodeFilterBlock, NodeFilterLeaf, NodeFilterExists, NodeFilterNode } from "../../src/editor/model/nodeFilter";

// ── fixture helpers (mirrors autoName.test.ts style) ────────────────────────

const ROOT_TC_ID = "tc-root";

const TCS: Record<string, TableConfigRef> = {
  [ROOT_TC_ID]: {
    id: ROOT_TC_ID, name: "Opportunity", tableLogicalName: "opportunity",
    tableConfigType: "RootTable", parentTableConfigId: null,
    lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
  },
};

function cond(p: Partial<ConditionNode>): ConditionNode {
  return {
    id: "c1", name: "", tableConfigId: ROOT_TC_ID, conditionType: "FieldComparison",
    comparisonColumn: null, comparisonOperator: null, valueSource: 1,
    comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null,
    ...p,
  };
}

function group(conditions: ConditionNode[], p: Partial<ConditionGroupNode> = {}): ConditionGroupNode {
  return {
    id: "g1", name: "", parentGroupId: null, logicalOperator: "And",
    isExecutionCondition: false, conditions, groups: [],
    ...p,
  };
}

function action(p: Partial<ActionNode>): ActionNode {
  return {
    id: "a1", name: "", order: 1, actionType: "ShowMessage",
    fireOn: 1, targetColumn: null, targetTable: null, targetNodeId: null,
    message: "Required message", fieldMapping: null, value: null,
    applyInverseWhenNotFired: null, severity: null, isActive: true,
    localizedMessages: [],
    ...p,
  };
}

function graph(
  validationGroups: ConditionGroupNode[],
  actions: ActionNode[],
  executionGroups: ConditionGroupNode[] = [],
): RuleGraph {
  return {
    rule: {
      id: "r1", name: "Test Rule", tableLogicalName: "opportunity",
      statusCode: 1, etag: null, triggers: [], channels: [],
      effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: ROOT_TC_ID, triggerColumns: [],
    },
    executionGroups,
    validationGroups,
    actions,
    tableConfigs: TCS,
  };
}

function graphWith(overrides: Partial<RuleGraph>): RuleGraph {
  return { ...graph([], [action({ id: "a1" })]), ...overrides };
}

// ── FieldComparison presence hints ──────────────────────────────────────────

describe("hintIssues — FieldComparison", () => {
  it("flags HINT_MISSING_FIELD when comparisonColumn is null", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: null, comparisonOperator: 1, comparisonValue: "100" })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_FIELD" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/column/i);
  });

  it("flags HINT_MISSING_FIELD when comparisonOperator is null", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: null, comparisonValue: "100" })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_FIELD" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/operator/i);
  });

  it("flags HINT_MISSING_FIELD when literal value is null (non-null-check operator)", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 1 /* Equals */, valueSource: 1, comparisonValue: null })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_FIELD" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/value/i);
  });

  it("flags HINT_MISSING_FIELD when field-reference column is null (valueSource=2)", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 1, valueSource: 2, comparisonValueColumn: null })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_FIELD" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/field.reference|reference column/i);
  });

  it("does NOT flag a value hint for IsNull operator (9)", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9 /* IsNull */, comparisonValue: null })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const valueHint = issues.find((i) => i.nodeId === "c1" && i.message.match(/value/i));
    expect(valueHint).toBeUndefined();
  });

  it("does NOT flag a value hint for IsNotNull operator (10)", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 10 /* IsNotNull */, comparisonValue: null })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const valueHint = issues.find((i) => i.nodeId === "c1" && i.message.match(/value/i));
    expect(valueHint).toBeUndefined();
  });
});

// ── RowCount presence hints ──────────────────────────────────────────────────

describe("hintIssues — RowCount", () => {
  it("flags HINT_MISSING_FIELD when both min and max are null", () => {
    const g = graph(
      [group([cond({ id: "c1", conditionType: "RowCount", comparisonColumn: null, comparisonOperator: null, minExpectedRows: null, maxExpectedRows: null })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_FIELD" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/minimum|maximum|row/i);
  });

  it("does NOT flag when only minExpectedRows is set", () => {
    const g = graph(
      [group([cond({ id: "c1", conditionType: "RowCount", comparisonColumn: null, comparisonOperator: null, minExpectedRows: 1, maxExpectedRows: null })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g).filter((i) => i.nodeId === "c1");
    expect(issues).toHaveLength(0);
  });
});

// ── RegexMatch presence hints ────────────────────────────────────────────────

describe("hintIssues — RegexMatch", () => {
  it("flags HINT_MISSING_FIELD when comparisonColumn is null", () => {
    const g = graph(
      [group([cond({ id: "c1", conditionType: "RegexMatch", comparisonColumn: null, comparisonValue: "^.+$" })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_FIELD" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/column/i);
  });

  it("flags HINT_MISSING_FIELD when regex pattern (comparisonValue) is null", () => {
    const g = graph(
      [group([cond({ id: "c1", conditionType: "RegexMatch", comparisonColumn: "email", comparisonValue: null })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_FIELD" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/pattern/i);
  });
});

// ── Expression presence hints ────────────────────────────────────────────────

describe("hintIssues — Expression", () => {
  it("flags HINT_MISSING_FIELD when expression is blank", () => {
    const g = graph(
      [group([cond({ id: "c1", conditionType: "Expression", expression: null, comparisonOperator: 1 })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_FIELD" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/expression/i);
  });

  it("flags HINT_INVALID_EXPRESSION when the expression does not parse", () => {
    const g = graph(
      [group([cond({ id: "c1", conditionType: "Expression", expression: "1 +", comparisonOperator: 1 })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_INVALID_EXPRESSION" && i.nodeId === "c1");
    expect(hit).toBeDefined();
  });

  it("flags HINT_MISSING_FIELD when comparisonOperator is null", () => {
    const g = graph(
      [group([cond({ id: "c1", conditionType: "Expression", expression: "{root.creditlimit} + 1", comparisonOperator: null })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_FIELD" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/operator/i);
  });

  it("does not flag a complete, parseable Expression condition", () => {
    const g = graph(
      [group([cond({ id: "c1", conditionType: "Expression", expression: "{root.creditlimit} + 1", comparisonOperator: 3 })])],
      [action({ id: "a1" })],
    );
    expect(hintIssues(g).filter((i) => i.nodeId === "c1")).toHaveLength(0);
  });
});

// ── Action presence hints ────────────────────────────────────────────────────

describe("hintIssues — actions", () => {
  it("flags HINT_MISSING_MESSAGE when ShowMessage action has no message", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9 })])],
      [action({ id: "a1", actionType: "ShowMessage", message: null })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_MESSAGE" && i.nodeId === "a1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/message/i);
  });

  it("flags HINT_MISSING_MESSAGE when Block action has no message", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9 })])],
      [action({ id: "a1", actionType: "Block", message: null })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_MESSAGE" && i.nodeId === "a1");
    expect(hit).toBeDefined();
  });

  it("flags HINT_MISSING_TARGET_COLUMN when SetVisible has no targetColumn", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9 })])],
      [action({ id: "a1", actionType: "SetVisible", targetColumn: null, message: null })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_TARGET_COLUMN" && i.nodeId === "a1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/target column/i);
  });

  it("flags HINT_MISSING_TARGET_COLUMN when SetRequired has no targetColumn", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9 })])],
      [action({ id: "a1", actionType: "SetRequired", targetColumn: null, message: null })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_TARGET_COLUMN" && i.nodeId === "a1");
    expect(hit).toBeDefined();
  });

  it("flags HINT_MISSING_TARGET_TABLE when CreateRecord has no targetTable", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9 })])],
      [action({ id: "a1", actionType: "CreateRecord", targetTable: null, message: null })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_MISSING_TARGET_TABLE" && i.nodeId === "a1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/target table/i);
  });
});

// ── Complete minimal rule → no hints ────────────────────────────────────────

describe("hintIssues — no hints for complete minimal rule", () => {
  it("returns empty for a complete FieldComparison rule with ShowMessage action", () => {
    const g = graph(
      [group([cond({
        id: "c1",
        comparisonColumn: "creditlimit",
        comparisonOperator: 1,  // Equals
        valueSource: 1,         // Literal
        comparisonValue: "10000",
      })])],
      [action({ id: "a1", actionType: "ShowMessage", message: "Credit limit exceeded." })],
    );
    expect(hintIssues(g)).toEqual([]);
  });

  it("returns empty for a complete IsNull condition (no value needed)", () => {
    const g = graph(
      [group([cond({
        id: "c1",
        comparisonColumn: "creditlimit",
        comparisonOperator: 9,  // IsNull: no value required
        comparisonValue: null,
      })])],
      [action({ id: "a1", actionType: "SetRequired", targetColumn: "creditlimit", message: null })],
    );
    expect(hintIssues(g)).toEqual([]);
  });

  it("returns empty for a complete RowCount rule", () => {
    const g = graph(
      [group([cond({
        id: "c1",
        conditionType: "RowCount",
        comparisonColumn: null,
        comparisonOperator: null,
        minExpectedRows: 1,
        maxExpectedRows: null,
      })])],
      [action({ id: "a1", actionType: "Block", message: "Too few rows." })],
    );
    expect(hintIssues(g)).toEqual([]);
  });

  it("returns empty for a complete field-reference condition", () => {
    const g = graph(
      [group([cond({
        id: "c1",
        comparisonColumn: "creditlimit",
        comparisonOperator: 4, // GreaterThanOrEqual
        valueSource: 2,        // FieldReference
        comparisonValueColumn: "otherfield",
      })])],
      [action({ id: "a1", actionType: "ShowMessage", message: "Over budget." })],
    );
    expect(hintIssues(g)).toEqual([]);
  });
});

// ── executionGroups are also checked ────────────────────────────────────────

describe("hintIssues — executionGroups", () => {
  it("flags conditions in executionGroups too", () => {
    const execGroup = group(
      [cond({ id: "exec-c1", comparisonColumn: null, comparisonOperator: 1, comparisonValue: "x" })],
      { id: "exec-g1", isExecutionCondition: true },
    );
    const g = graph(
      [],
      [action({ id: "a1" })],
      [execGroup],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.nodeId === "exec-c1");
    expect(hit).toBeDefined();
    expect(hit!.code).toBe("HINT_MISSING_FIELD");
  });
});

// ── HINT_INCOMPLETE_FIELD_MAPPING hints ──────────────────────────────────────

describe("hintIssues — HINT_INCOMPLETE_FIELD_MAPPING", () => {
  it("flags an incomplete field-mapping row on a write action", () => {
    const a = action({ id: "a1", actionType: "CreateRecord", targetTable: "task",
      fieldMapping: JSON.stringify([{ target: "subject", source: "root" }]) }); // root source w/ no column
    const g = graphWith({ actions: [a] });
    expect(hintIssues(g).some((i) => i.code === "HINT_INCOMPLETE_FIELD_MAPPING" && i.nodeId === "a1")).toBe(true);
  });

  it("does not flag a complete field mapping", () => {
    const a = action({ id: "a1", actionType: "CreateRecord", targetTable: "task",
      fieldMapping: JSON.stringify([{ target: "subject", source: "literal", value: "Hi" }]) });
    const g = graphWith({ actions: [a] });
    expect(hintIssues(g).some((i) => i.code === "HINT_INCOMPLETE_FIELD_MAPPING")).toBe(false);
  });
});

// ── tableConfigs lookup-target-id hints ──────────────────────────────────────

describe("hintIssues — HINT_MISSING_LOOKUP_TARGET_ID", () => {
  it("flags a LookupTable node missing lookupTargetIdAttribute", () => {
    const g = graphWith({
      tableConfigs: {
        [ROOT_TC_ID]: TCS[ROOT_TC_ID],
        l1: { id: "l1", name: "L1", tableLogicalName: "perf_lookup1", tableConfigType: "LookupTable",
              parentTableConfigId: ROOT_TC_ID, lookupColumnLogicalName: "perf_lookup1id",
              childLinkField: null, lookupTargetIdAttribute: null },
      },
    });
    expect(hintIssues(g).some((i) => i.code === "HINT_MISSING_LOOKUP_TARGET_ID" && i.nodeId === "l1")).toBe(true);
  });

  it("does not flag a LookupTable node that has the attribute", () => {
    const g = graphWith({
      tableConfigs: {
        [ROOT_TC_ID]: TCS[ROOT_TC_ID],
        l1: { id: "l1", name: "L1", tableLogicalName: "perf_lookup1", tableConfigType: "LookupTable",
              parentTableConfigId: ROOT_TC_ID, lookupColumnLogicalName: "perf_lookup1id",
              childLinkField: null, lookupTargetIdAttribute: "perf_lookup1id" },
      },
    });
    expect(hintIssues(g).some((i) => i.code === "HINT_MISSING_LOOKUP_TARGET_ID")).toBe(false);
  });

  it("does not flag non-Lookup nodes", () => {
    const g = graphWith({
      tableConfigs: {
        [ROOT_TC_ID]: TCS[ROOT_TC_ID],
        c1: { id: "c1", name: "C1", tableLogicalName: "perf_child1", tableConfigType: "ChildTable",
              parentTableConfigId: ROOT_TC_ID, lookupColumnLogicalName: null,
              childLinkField: "perf_rootid", lookupTargetIdAttribute: null },
      },
    });
    expect(hintIssues(g).some((i) => i.code === "HINT_MISSING_LOOKUP_TARGET_ID")).toBe(false);
  });
});

// ── HINT_AGGREGATE_FILTER_KEY hints (mathexpr field-mapping filter integrity) ──

describe("hintIssues — HINT_AGGREGATE_FILTER_KEY", () => {
  const emptyFilterGroup = {
    kind: "group" as const,
    id: "grp1",
    op: "and" as const,
    rules: [],
  };

  it("flags when a mathexpr field-mapping row references a filter key not in filters", () => {
    const a = action({
      id: "a1", actionType: "CreateRecord", targetTable: "task",
      fieldMapping: JSON.stringify([
        { target: "value", source: "mathexpr", expression: "sum(node:f47bf4f2-e947-4e18-b3b4-3c2a5a8c5d9f.amount filter:f1)", filters: null },
      ]),
    });
    const g = graphWith({ actions: [a] });
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_AGGREGATE_FILTER_KEY" && i.nodeId === "a1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/filter|aggregate/i);
  });

  it("flags when a mathexpr field-mapping row has an orphan filter key not referenced in expression", () => {
    const a = action({
      id: "a1", actionType: "CreateRecord", targetTable: "task",
      fieldMapping: JSON.stringify([
        { target: "value", source: "mathexpr", expression: "sum(node:f47bf4f2-e947-4e18-b3b4-3c2a5a8c5d9f.amount)", filters: { f1: emptyFilterGroup } },
      ]),
    });
    const g = graphWith({ actions: [a] });
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_AGGREGATE_FILTER_KEY" && i.nodeId === "a1");
    expect(hit).toBeDefined();
  });

  it("does not flag a complete filtered aggregate (matching keys)", () => {
    const a = action({
      id: "a1", actionType: "CreateRecord", targetTable: "task",
      fieldMapping: JSON.stringify([
        { target: "value", source: "mathexpr", expression: "sum(node:f47bf4f2-e947-4e18-b3b4-3c2a5a8c5d9f.amount filter:f1)", filters: { f1: emptyFilterGroup } },
      ]),
    });
    const g = graphWith({ actions: [a] });
    const issues = hintIssues(g);
    expect(issues.filter((i) => i.code === "HINT_AGGREGATE_FILTER_KEY")).toHaveLength(0);
  });

  it("does not flag a mathexpr without any aggregate functions", () => {
    const a = action({
      id: "a1", actionType: "CreateRecord", targetTable: "task",
      fieldMapping: JSON.stringify([
        { target: "value", source: "mathexpr", expression: "{root.amount} + 100", filters: null },
      ]),
    });
    const g = graphWith({ actions: [a] });
    const issues = hintIssues(g);
    expect(issues.filter((i) => i.code === "HINT_AGGREGATE_FILTER_KEY")).toHaveLength(0);
  });

  it("does not flag a non-mathexpr field-mapping row", () => {
    const a = action({
      id: "a1", actionType: "CreateRecord", targetTable: "task",
      fieldMapping: JSON.stringify([
        { target: "subject", source: "literal", value: "Test" },
      ]),
    });
    const g = graphWith({ actions: [a] });
    const issues = hintIssues(g);
    expect(issues.filter((i) => i.code === "HINT_AGGREGATE_FILTER_KEY")).toHaveLength(0);
  });
});

// ── HINT_EXISTS_* hints (exists-filter conditions) ──────────────────────────

function exists(p: Partial<NodeFilterExists> = {}): NodeFilterExists {
  return {
    kind: "exists", id: "exists1", collectionNodeId: null,
    minCount: null, maxCount: null,
    sub: { kind: "group", id: "grp-sub", op: "and", rules: [] },
    ...p,
  };
}

describe("hintIssues — EXISTS filter", () => {
  it("flags HINT_EXISTS_INCOMPLETE when exists has no collection", () => {
    const filter = [filterBlock({}, [exists({ collectionNodeId: null })])];
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9, filter })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_EXISTS_INCOMPLETE" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/collection|related.rows/i);
  });

  it("flags HINT_EXISTS_COUNT_RANGE when minCount > maxCount", () => {
    const filter = [filterBlock({}, [exists({ collectionNodeId: "tc-child", minCount: 5, maxCount: 2 })])];
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9, filter })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_EXISTS_COUNT_RANGE" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/minimum|maximum/i);
  });

  it("does not flag a complete exists with collection and valid range", () => {
    const filter = [filterBlock({}, [exists({ collectionNodeId: "tc-child", minCount: 1, maxCount: 5 })])];
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9, filter })])],
      [action({ id: "a1" })],
    );
    expect(hintIssues(g).filter((i) => i.code.startsWith("HINT_EXISTS_") && i.nodeId === "c1")).toHaveLength(0);
  });

  it("does not flag exists with collection and no bounds", () => {
    const filter = [filterBlock({}, [exists({ collectionNodeId: "tc-child", minCount: null, maxCount: null })])];
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9, filter })])],
      [action({ id: "a1" })],
    );
    expect(hintIssues(g).filter((i) => i.code.startsWith("HINT_EXISTS_") && i.nodeId === "c1")).toHaveLength(0);
  });

  it("recurses into the sub-filter and flags incomplete scalar rules within it", () => {
    const subLeaf = leaf({ column: "status", operator: 1, value: null }); // partial rule in sub
    const filter = [filterBlock({}, [exists({ collectionNodeId: "tc-child", sub: { kind: "group", id: "grp-sub", op: "and", rules: [subLeaf] } })])];
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9, filter })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_INCOMPLETE_FILTER" && i.nodeId === "c1");
    expect(hit).toBeDefined();
  });
});

// ── HINT_INCOMPLETE_FILTER hints (node-filtered conditions) ─────────────────

function leaf(p: Partial<NodeFilterLeaf> = {}): NodeFilterLeaf {
  return {
    kind: "rule", id: "leaf1", column: null, operator: null,
    valueSource: 1, value: null, valueNodeId: null, valueColumn: null,
    ...p,
  };
}

function filterBlock(p: Partial<NodeFilterBlock> = {}, leaves: NodeFilterNode[] = [leaf()]): NodeFilterBlock {
  return {
    targetNodeId: "tc-target",
    root: { kind: "group", id: "grp1", op: "and", rules: leaves },
    ...p,
  };
}

describe("hintIssues — HINT_INCOMPLETE_FILTER", () => {
  it("flags a filter leaf that has column + operator set but no value (non-valueless op)", () => {
    const filter = [filterBlock({}, [leaf({ column: "creditlimit", operator: 1 /* Equals */, value: null })])];
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9, filter })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_INCOMPLETE_FILTER" && i.nodeId === "c1");
    expect(hit).toBeDefined();
  });

  it("flags a filter block with completed criteria but no targetNodeId", () => {
    const filter = [filterBlock({ targetNodeId: null }, [leaf({ column: "creditlimit", operator: 9 /* IsNull */ })])];
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9, filter })])],
      [action({ id: "a1" })],
    );
    const issues = hintIssues(g);
    const hit = issues.find((i) => i.code === "HINT_INCOMPLETE_FILTER" && i.nodeId === "c1");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/target node/i);
  });

  it("does not flag a fully complete filter (leaf complete + targetNodeId set)", () => {
    const filter = [filterBlock({ targetNodeId: "tc-target" }, [
      leaf({ column: "creditlimit", operator: 1 /* Equals */, valueSource: 1, value: "100" }),
    ])];
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9, filter })])],
      [action({ id: "a1" })],
    );
    expect(hintIssues(g).filter((i) => i.code === "HINT_INCOMPLETE_FILTER")).toHaveLength(0);
  });

  it("does not flag an untouched (empty) filter", () => {
    const filter = [filterBlock({ targetNodeId: null }, [leaf()])];
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9, filter })])],
      [action({ id: "a1" })],
    );
    expect(hintIssues(g).filter((i) => i.code === "HINT_INCOMPLETE_FILTER")).toHaveLength(0);
  });

  it("does not flag a condition with a null filter", () => {
    const g = graph(
      [group([cond({ id: "c1", comparisonColumn: "creditlimit", comparisonOperator: 9, filter: null })])],
      [action({ id: "a1" })],
    );
    expect(hintIssues(g).filter((i) => i.code === "HINT_INCOMPLETE_FILTER")).toHaveLength(0);
  });
});
