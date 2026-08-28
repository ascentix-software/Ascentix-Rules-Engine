import type { ColumnKind } from "./columnKind";

// Operator value codes mirror the C# ComparisonOperator enum.
const EQUALITY = [1, 2, 9, 10]; // Equals, NotEquals, IsNull, IsNotNull
const ORDERED = [1, 2, 3, 4, 5, 6, 9, 10]; // + GreaterThan/GTE/LessThan/LTE
const TEXTUAL = [1, 2, 7, 8, 9, 10]; // + Contains/DoesNotContain
const EXPRESSION_NUMERIC = [1, 2, 3, 4, 5, 6]; // Equals, NotEquals, GreaterThan, GTE, LessThan, LTE

/**
 * Operators the engine can meaningfully evaluate for a column kind.
 * Mirror of the C# ComparisonOperatorSupport matrix (kept in sync by parallel tests).
 */
export function allowedOperators(kind: ColumnKind): number[] {
  switch (kind) {
    case "number":
    case "datetime":
      return ORDERED;
    case "text":
    case "multiselect":
      return TEXTUAL;
    case "boolean":
    case "optionset":
    case "lookup":
      return EQUALITY;
    default:
      return TEXTUAL; // unknown → text set (mirrors columnKind fallback)
  }
}

/**
 * Operators valid for an Expression condition, whose LHS is a computed numeric mathexpr
 * rather than a stored column, kept separate from allowedOperators(kind) since there is no
 * ColumnKind for "numeric expression". No IsNull/IsNotNull (an expression always evaluates to
 * a value or "no value", never a stored null); no Contains/DoesNotContain (text-only).
 * Mirrors the C# ComparisonOperatorSupport.ForExpression.
 */
export function allowedOperatorsForExpression(): number[] {
  return EXPRESSION_NUMERIC;
}
