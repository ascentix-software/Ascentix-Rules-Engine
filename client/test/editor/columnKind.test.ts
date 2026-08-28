import { describe, it, expect } from "vitest";
import { columnKind, sameFamily } from "../../src/editor/ui/columnKind";

describe("columnKind", () => {
  it("maps optionset-family attribute types", () => {
    expect(columnKind("Picklist")).toBe("optionset");
    expect(columnKind("State")).toBe("optionset");
    expect(columnKind("Status")).toBe("optionset");
  });
  it("maps multi-select, boolean, lookup", () => {
    expect(columnKind("Virtual")).toBe("multiselect");
    expect(columnKind("Boolean")).toBe("boolean");
    expect(columnKind("Lookup")).toBe("lookup");
    expect(columnKind("Customer")).toBe("lookup");
    expect(columnKind("Owner")).toBe("lookup");
  });
  it("maps numeric and datetime types", () => {
    for (const t of ["Integer", "BigInt", "Decimal", "Double", "Money"]) {
      expect(columnKind(t)).toBe("number");
    }
    expect(columnKind("DateTime")).toBe("datetime");
  });
  it("falls back to text for anything else", () => {
    expect(columnKind("String")).toBe("text");
    expect(columnKind("Memo")).toBe("text");
    expect(columnKind("Uniqueidentifier")).toBe("text");
  });
  it("sameFamily is kind equality", () => {
    expect(sameFamily("optionset", "optionset")).toBe(true);
    expect(sameFamily("number", "number")).toBe(true);
    expect(sameFamily("lookup", "text")).toBe(false);
  });
});
