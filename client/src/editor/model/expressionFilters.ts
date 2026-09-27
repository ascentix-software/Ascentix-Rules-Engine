// asx_rulecondition.asx_expressionfilters: a Calculation condition's aggregate filters, keyed
// by the `filter:<key>` tokens in its expression. Same JSON map as a field-mapping mathexpr
// entry's `filters` (Core/Actions/AggregateFilterParser.cs reads both).

import type { NodeFilterGroupModel } from "./nodeFilter";

export type ExpressionFilters = Record<string, NodeFilterGroupModel>;

export function parseExpressionFilters(json: string | null | undefined): ExpressionFilters | null {
  if (json == null || json.trim() === "") return null;
  try {
    const data: unknown = JSON.parse(json);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    return data as ExpressionFilters;
  } catch {
    return null;
  }
}

export function serializeExpressionFilters(f: ExpressionFilters | null | undefined): string | null {
  return f && Object.keys(f).length > 0 ? JSON.stringify(f) : null;
}
