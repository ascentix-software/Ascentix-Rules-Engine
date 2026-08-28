import type { XrmAdapter } from "./xrm";

// Builds the asx_RunRules RecordJson object from current form values for the
// given root dependency columns. Mirrors the server RecordJsonDeserializer
// contract. Columns not present on the form layout are
// OMITTED (so the server's RetrieveAndOverlay uses the persisted value rather
// than wiping it). On-form cleared fields are sent as null (overlay-clear).
export function buildRecordJson(xrm: XrmAdapter, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    if (!xrm.hasAttribute(col)) continue; // off-form → omit
    out[col] = encode(xrm.getAttributeType(col), xrm.getValue(col));
  }
  return out;
}

export function encodeRecordJson(xrm: XrmAdapter, columns: string[]): string {
  return JSON.stringify(buildRecordJson(xrm, columns));
}

function encode(type: string | null, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "lookup": {
      const arr = value as Array<{ id?: string; entityType?: string }>;
      if (!arr || arr.length === 0) return null;
      const ref = arr[0];
      if (!ref.id || !ref.entityType) return null;
      return { id: ref.id.replace(/[{}]/g, ""), logicalname: ref.entityType };
    }
    case "multiselectoptionset":
      return value; // number[]
    case "datetime":
      return value instanceof Date ? value.toISOString() : value;
    // optionset/boolean/integer/decimal/double/money/string/memo: primitive as-is
    default:
      return value;
  }
}
