import type { ColumnKind } from "../ui/columnKind";

/**
 * Encode a ValueEditor string into the asx_fieldmapping literal `value`, matching the server
 * LiteralCoercer/JsonPrimitiveDecoder contract: lookup → { id, logicalname }, multiselect → int[],
 * everything else → the string (server coerces via Convert.* / OptionSetValue(ToInt) / DateTime.Parse).
 */
export function literalToJsonValue(kind: ColumnKind, str: string, lookupTarget?: string): unknown {
  if (kind === "multiselect") {
    return (str ?? "").split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
  }
  if (kind === "lookup") {
    return str ? { id: str, logicalname: lookupTarget ?? "" } : null;
  }
  return str;
}

/** Reverse of literalToJsonValue: rehydrate the ValueEditor string from a stored literal value. */
export function jsonValueToLiteralString(kind: ColumnKind, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (kind === "multiselect") return Array.isArray(value) ? value.join(",") : String(value);
  if (kind === "lookup") return value && typeof value === "object" ? String((value as any).id ?? "") : String(value);
  return String(value);
}
