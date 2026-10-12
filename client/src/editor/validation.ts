/**
 * Thin, advisory, client-side structural hints: a TS subset of the C# StructuralChecks.
 * These are presence-only checks (missing column/operator/value/message/target) that give
 * instant inline feedback in the editor. The authoritative verdict is always the server API.
 */
import type { RuleGraph, ConditionNode, ConditionGroupNode, ActionNode } from "./model/types";
import { parseFieldMapping, validateRows } from "./model/fieldMapping";
import { parseMathExpr } from "./model/mathExpr";
import { isLeafComplete, isGroupEmpty, type NodeFilterGroupModel, type NodeFilterLeaf } from "./model/nodeFilter";
import { actionRunsOn, missingTriggerHint } from "./model/actionTriggers";

export interface HintIssue {
  /** Hint code, always prefixed with HINT_. */
  code: string;
  /** Human-readable description. */
  message: string;
  /** The id of the node (ConditionNode or ActionNode) that has the issue. */
  nodeId: string;
  /** Defaults to Error (blocks publishing). */
  severity?: "Warning";
}

// Operators that do not require a comparison value (mirrors C# ComparisonOperator.IsNull/IsNotNull).
// In the editor model these are stored as numbers: 9 = IsNull, 10 = IsNotNull.
const NULL_CHECK_OPERATORS = new Set([9, 10]);

// ── public entry point ───────────────────────────────────────────────────────

/**
 * Walk a RuleGraph and return advisory HintIssues for any missing required fields.
 * Never throws; returns [] for a complete rule.
 */
export function hintIssues(graph: RuleGraph): HintIssue[] {
  const issues: HintIssue[] = [];

  for (const grp of graph.executionGroups) {
    collectGroupHints(grp, issues);
  }
  for (const grp of graph.validationGroups) {
    collectGroupHints(grp, issues);
  }
  for (const a of graph.actions) {
    collectActionHints(a, issues);
    // An active action whose type does nothing under the rule's triggers (a form message on an
    // update-only rule) never runs. A warning: it doesn't break the rule, it's just dead.
    if ((a.isActive ?? true) && a.actionType && !actionRunsOn(a.actionType, graph.rule.triggers)) {
      issues.push({ code: "HINT_ACTION_NEVER_RUNS", message: missingTriggerHint(a.actionType), nodeId: a.id, severity: "Warning" });
    }
  }
  for (const node of Object.values(graph.tableConfigs)) {
    if (node.tableConfigType === "LookupTable" && !node.lookupTargetIdAttribute) {
      issues.push({
        code: "HINT_MISSING_LOOKUP_TARGET_ID",
        message: "Re-pick the relationship: this lookup has no target id attribute.",
        nodeId: node.id,
      });
    }
  }

  return issues;
}

// ── group/condition traversal ────────────────────────────────────────────────

function collectGroupHints(group: ConditionGroupNode, issues: HintIssue[]): void {
  for (const c of group.conditions) {
    collectConditionHints(c, issues);
  }
  for (const child of group.groups) {
    collectGroupHints(child, issues);
  }
}

function collectConditionHints(c: ConditionNode, issues: HintIssue[]): void {
  switch (c.conditionType) {
    case "FieldComparison":
      checkFieldComparison(c, issues);
      break;
    case "RowCount":
      checkRowCount(c, issues);
      break;
    case "RegexMatch":
      checkRegexMatch(c, issues);
      break;
    case "Expression":
      checkExpression(c, issues);
      break;
    // null conditionType → nothing to check yet (user hasn't chosen a type)
  }
  checkNodeFilter(c, issues); // filter applies regardless of conditionType
}

function checkFieldComparison(c: ConditionNode, issues: HintIssue[]): void {
  if (!c.comparisonColumn) {
    issues.push({ code: "HINT_MISSING_FIELD", message: "Choose a column to compare.", nodeId: c.id });
  }
  if (c.comparisonOperator === null) {
    issues.push({ code: "HINT_MISSING_FIELD", message: "Choose an operator.", nodeId: c.id });
    return; // further value checks are meaningless without an operator
  }
  if (!NULL_CHECK_OPERATORS.has(c.comparisonOperator)) {
    // Value is required: check by source
    if (c.valueSource === 2 /* FieldReference */) {
      if (!c.comparisonValueColumn) {
        issues.push({ code: "HINT_MISSING_FIELD", message: "Choose the column to compare against.", nodeId: c.id });
      }
    } else /* Literal (1) or null */ {
      if (!c.comparisonValue) {
        issues.push({ code: "HINT_MISSING_FIELD", message: "Enter a value to compare against.", nodeId: c.id });
      }
    }
  }
}

function checkRowCount(c: ConditionNode, issues: HintIssue[]): void {
  if (c.minExpectedRows === null && c.maxExpectedRows === null) {
    issues.push({ code: "HINT_MISSING_FIELD", message: "Enter a minimum or maximum row count.", nodeId: c.id });
  }
}

function checkRegexMatch(c: ConditionNode, issues: HintIssue[]): void {
  if (!c.comparisonColumn) {
    issues.push({ code: "HINT_MISSING_FIELD", message: "Choose a column to match.", nodeId: c.id });
  }
  if (!c.comparisonValue) {
    issues.push({ code: "HINT_MISSING_FIELD", message: "Enter a pattern to match.", nodeId: c.id });
  }
}

function checkExpression(c: ConditionNode, issues: HintIssue[]): void {
  if (!c.expression || !c.expression.trim()) {
    issues.push({ code: "HINT_MISSING_FIELD", message: "Enter a calculation.", nodeId: c.id });
  } else if (!parseMathExpr(c.expression).ok) {
    issues.push({ code: "HINT_INVALID_EXPRESSION", message: "Fix the calculation: it doesn't parse.", nodeId: c.id });
  }
  if (c.comparisonOperator === null) {
    issues.push({ code: "HINT_MISSING_FIELD", message: "Choose an operator.", nodeId: c.id });
  }
}

// ── node-filter checks ───────────────────────────────────────────────────────
//
// HINT_FILTER_OPERATOR_KIND (an ordering/etc. operator not in allowedOperators(kind) for the
// leaf's column) is intentionally NOT implemented here: allowedOperators() needs a ColumnKind,
// which requires resolving the block's target-node table + column through metadata, and
// hintIssues(graph) has no metadata input today (see TableConfigTree.tsx's synchronous call
// site). Adding that would mean new async metadata plumbing, which this pass avoids. The
// server's META_FILTER_OPERATOR_TYPE_MISMATCH check is authoritative for that case.

// A leaf is "partially filled" once the user has touched any field but hasn't finished it.
function leafIsPartial(l: NodeFilterLeaf): boolean {
  const anySet = !!l.column || l.operator != null || !!l.value || !!l.valueNodeId || !!l.valueColumn;
  return anySet && !isLeafComplete(l);
}

function walkFilterGroup(g: NodeFilterGroupModel, nodeId: string, issues: HintIssue[]): void {
  for (const n of g.rules) {
    if (n.kind === "group") {
      walkFilterGroup(n, nodeId, issues);
    } else if (n.kind === "rule" && leafIsPartial(n)) {
      issues.push({ code: "HINT_INCOMPLETE_FILTER", message: "Finish or remove the incomplete filter.", nodeId });
    } else if (n.kind === "exists") {
      // Check for incomplete collection (exists needs a target collection)
      if (n.collectionNodeId == null) {
        issues.push({ code: "HINT_EXISTS_INCOMPLETE", message: "Choose the related rows to filter on.", nodeId });
      }
      // Check for invalid count range (min cannot exceed max)
      if (n.minCount != null && n.maxCount != null && n.minCount > n.maxCount) {
        issues.push({ code: "HINT_EXISTS_COUNT_RANGE", message: "Make the minimum count no more than the maximum.", nodeId });
      }
      // Recurse into the sub-filter to check for incomplete scalar rules
      walkFilterGroup(n.sub, nodeId, issues);
    }
  }
}

function checkNodeFilter(c: ConditionNode, issues: HintIssue[]): void {
  if (!c.filter) return;
  for (const block of c.filter) {
    // A block with completed criteria but no chosen target node is incomplete.
    if (!block.targetNodeId && !isGroupEmpty(block.root)) {
      issues.push({ code: "HINT_INCOMPLETE_FILTER", message: "Choose which table the filter applies to.", nodeId: c.id });
    }
    walkFilterGroup(block.root, c.id, issues);
  }
}

// ── action checks ────────────────────────────────────────────────────────────

// A mapping is "incomplete" for the rule-tree hint if it can't be parsed or any row
// fails the model's own validation (missing target/column/node, bad template/dateexpr, dupes).
function mappingHasIssue(json: string | null | undefined): boolean {
  const result = parseFieldMapping(json ?? null);
  if (!result.ok) return true;
  return validateRows(result.rows).length > 0;
}

// Check for aggregate-filter key mismatches in mathexpr field-mapping rows:
// a referenced filter key missing from filters, or an orphan filters key.
// Returns true if any row has a key mismatch.
function mappingHasAggregateFilterKeyIssue(json: string | null | undefined): boolean {
  const result = parseFieldMapping(json ?? null);
  if (!result.ok) return false; // already flagged as incomplete
  for (const row of result.rows) {
    if (row.source !== "mathexpr" || !row.expression) continue;
    const parsed = parseMathExpr(row.expression);
    if (!parsed.ok) continue; // already flagged as incomplete
    // Collect referenced filter keys (only agg refs with filterKey set)
    const referencedKeys = new Set(
      parsed.refs.filter((r) => r.agg && r.filterKey).map((r) => r.filterKey as string)
    );
    // Collect defined filter keys
    const definedKeys = new Set(Object.keys(row.filters ?? {}));
    // Check for mismatch: missing or orphan keys
    if (referencedKeys.size !== definedKeys.size ||
        [...referencedKeys].some((k) => !definedKeys.has(k)) ||
        [...definedKeys].some((k) => !referencedKeys.has(k))) {
      return true;
    }
  }
  return false;
}

function collectActionHints(a: ActionNode, issues: HintIssue[]): void {
  switch (a.actionType) {
    case "SetVisible":
    case "SetRequired":
      if (!a.targetColumn) {
        issues.push({ code: "HINT_MISSING_TARGET_COLUMN", message: "Choose a target field.", nodeId: a.id });
      }
      break;
    case "ShowMessage":
    case "Block":
      if (!a.message) {
        issues.push({ code: "HINT_MISSING_MESSAGE", message: "Enter a message.", nodeId: a.id });
      }
      break;
    case "CreateRecord":
      if (!a.targetTable) {
        issues.push({ code: "HINT_MISSING_TARGET_TABLE", message: "Choose a table to create the record in.", nodeId: a.id });
      }
      if (mappingHasIssue(a.fieldMapping))
        issues.push({ code: "HINT_INCOMPLETE_FIELD_MAPPING", message: "Finish or remove the incomplete field mapping.", nodeId: a.id });
      if (mappingHasAggregateFilterKeyIssue(a.fieldMapping))
        issues.push({ code: "HINT_AGGREGATE_FILTER_KEY", message: "Match each calculation filter key to a filter, and remove unused ones.", nodeId: a.id });
      break;
    case "UpdateRecord":
    case "DeleteRecord":
    case "DeactivateRecord":
      if (!a.targetNodeId) {
        issues.push({ code: "HINT_MISSING_TARGET_NODE", message: "Choose the records to write.", nodeId: a.id });
      }
      if (a.actionType === "UpdateRecord" && mappingHasIssue(a.fieldMapping))
        issues.push({ code: "HINT_INCOMPLETE_FIELD_MAPPING", message: "Finish or remove the incomplete field mapping.", nodeId: a.id });
      if (a.actionType === "UpdateRecord" && mappingHasAggregateFilterKeyIssue(a.fieldMapping))
        issues.push({ code: "HINT_AGGREGATE_FILTER_KEY", message: "Match each calculation filter key to a filter, and remove unused ones.", nodeId: a.id });
      break;
    // null actionType → user hasn't chosen yet; no hint
  }
}
