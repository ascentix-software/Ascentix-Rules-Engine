export type ColumnKind =
  | "optionset" | "multiselect" | "boolean" | "lookup" | "number" | "datetime" | "text";

const MAP: Record<string, ColumnKind> = {
  Picklist: "optionset", State: "optionset", Status: "optionset",
  Virtual: "multiselect",
  Boolean: "boolean",
  Lookup: "lookup", Customer: "lookup", Owner: "lookup",
  Integer: "number", BigInt: "number", Decimal: "number", Double: "number", Money: "number",
  DateTime: "datetime",
};

export function columnKind(attributeType: string): ColumnKind {
  return MAP[attributeType] ?? "text";
}

export function sameFamily(a: ColumnKind, b: ColumnKind): boolean {
  return a === b;
}
