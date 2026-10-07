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

const TYPE_LABEL: Record<string, string> = {
  Money: "Currency", Integer: "Whole number", BigInt: "Whole number", Decimal: "Decimal", Double: "Decimal",
  Picklist: "Choice", State: "Choice", Status: "Choice", Virtual: "Choices", Boolean: "Yes/No",
  Lookup: "Lookup", Customer: "Lookup", Owner: "Lookup", DateTime: "Date", String: "Text", Memo: "Text",
};

/** A column type as authors know it ("Currency", "Choice", "Date"); "" when unknown. */
export function columnTypeLabel(attributeType: string | null | undefined): string {
  return attributeType ? TYPE_LABEL[attributeType] ?? "" : "";
}
