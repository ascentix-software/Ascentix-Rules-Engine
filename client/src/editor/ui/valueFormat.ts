export function formatBooleanLabel(
  value: string | null,
  labels: { trueLabel: string; falseLabel: string },
): string | null {
  if (value == null || value === "") return null;
  if (value === "true") return labels.trueLabel;
  if (value === "false") return labels.falseLabel;
  return value;
}

export function parseCsvValues(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

export function serializeCsvValues(values: string[]): string {
  return values.join(",");
}
