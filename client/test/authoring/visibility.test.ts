import { describe, it, expect } from "vitest";
import { conditionVisibility } from "../../src/authoring/visibility";

// asx_conditiontype: FieldComparison=1, RowCount=2, RegexMatch=3
// asx_comparisonvaluesource: Literal=1, FieldReference=2
// asx_actiontype: SetVisible=1, SetRequired=2, ShowMessage=3, Block=4, CreateRecord=5, UpdateRecord=6, DeleteRecord=7
// asx_tableconfigtype: RootTable=1, LookupTable=2, ChildTable=3

describe("conditionVisibility", () => {
  it("FieldComparison(1) + Literal(1) shows comparison + value, hides ref + rowcount", () => {
    const v = conditionVisibility(1, 1);
    expect(v.sections).toEqual({ comparison: true, rowcount: false });
    expect(v.controls).toEqual({
      asx_comparisoncolumn: true, asx_comparisonoperator: true, asx_comparisonvaluesource: true,
      asx_comparisonvalue: true, asx_comparisonvaluecolumn: false, asx_comparisonvaluenode: false,
      asx_minexpectedrows: false, asx_maxexpectedrows: false, ConditionSearchCriteriaGrid: false,
    });
  });

  it("FieldComparison(1) + FieldReference(2) swaps value for ref column + node", () => {
    const v = conditionVisibility(1, 2);
    expect(v.controls.asx_comparisonvalue).toBe(false);
    expect(v.controls.asx_comparisonvaluecolumn).toBe(true);
    expect(v.controls.asx_comparisonvaluenode).toBe(true);
  });

  it("RowCount(2) shows rowcount section + subgrid, hides comparison", () => {
    const v = conditionVisibility(2, null);
    expect(v.sections).toEqual({ comparison: false, rowcount: true });
    expect(v.controls.asx_minexpectedrows).toBe(true);
    expect(v.controls.asx_maxexpectedrows).toBe(true);
    expect(v.controls.ConditionSearchCriteriaGrid).toBe(true);
  });

  it("RegexMatch(3) shows the comparison column + the pattern value, hides operator/value-source", () => {
    const v = conditionVisibility(3, null);
    expect(v.sections).toEqual({ comparison: true, rowcount: false });
    expect(v.controls.asx_comparisoncolumn).toBe(true);
    expect(v.controls.asx_comparisonvalue).toBe(true); // the regex pattern
    expect(v.controls.asx_comparisonoperator).toBe(false);
    expect(v.controls.asx_comparisonvaluesource).toBe(false);
    expect(v.controls.asx_comparisonvaluecolumn).toBe(false);
    expect(v.controls.asx_comparisonvaluenode).toBe(false);
    expect(v.controls.ConditionSearchCriteriaGrid).toBe(false);
  });
});

import { actionVisibility, tableConfigVisibility } from "../../src/authoring/visibility";

describe("actionVisibility", () => {
  const keys = ["asx_targetcolumn","asx_valuebool","asx_applyinversewhennotfired",
    "asx_message","asx_severity","asx_targettable","asx_targetnode","asx_fieldmapping"];
  const shown = (v: { controls: Record<string, boolean> }) => keys.filter((k) => v.controls[k]);

  it("SetVisible(1) shows target column + bool + inverse", () => {
    expect(shown(actionVisibility(1)).sort())
      .toEqual(["asx_applyinversewhennotfired","asx_targetcolumn","asx_valuebool"]);
  });
  it("SetRequired(2) shows target column + bool + inverse", () => {
    expect(shown(actionVisibility(2)).sort())
      .toEqual(["asx_applyinversewhennotfired","asx_targetcolumn","asx_valuebool"]);
  });
  it("ShowMessage(3) shows message + severity", () => {
    expect(shown(actionVisibility(3)).sort()).toEqual(["asx_message","asx_severity"]);
  });
  it("Block(4) shows message + severity + target column", () => {
    expect(shown(actionVisibility(4)).sort()).toEqual(["asx_message","asx_severity","asx_targetcolumn"]);
  });
  it("CreateRecord(5) shows target table + field mapping", () => {
    expect(shown(actionVisibility(5)).sort()).toEqual(["asx_fieldmapping","asx_targettable"]);
  });
  it("UpdateRecord(6) shows target node + field mapping", () => {
    expect(shown(actionVisibility(6)).sort()).toEqual(["asx_fieldmapping","asx_targetnode"]);
  });
  it("DeleteRecord(7) shows target node only", () => {
    expect(shown(actionVisibility(7)).sort()).toEqual(["asx_targetnode"]);
  });
});

describe("tableConfigVisibility", () => {
  it("RootTable(1) hides all linkage", () => {
    const c = tableConfigVisibility(1).controls;
    expect(c).toEqual({ asx_parenttable: false, asx_lookupcolumnlogicalname: false,
      asx_lookuptargetidattribute: false, asx_childlinkfield: false });
  });
  it("LookupTable(2) shows parent + lookup column + target id attribute", () => {
    const c = tableConfigVisibility(2).controls;
    expect(c.asx_parenttable).toBe(true);
    expect(c.asx_lookupcolumnlogicalname).toBe(true);
    expect(c.asx_lookuptargetidattribute).toBe(true);
    expect(c.asx_childlinkfield).toBe(false);
  });
  it("ChildTable(3) shows parent + child link field", () => {
    const c = tableConfigVisibility(3).controls;
    expect(c.asx_parenttable).toBe(true);
    expect(c.asx_childlinkfield).toBe(true);
    expect(c.asx_lookupcolumnlogicalname).toBe(false);
    expect(c.asx_lookuptargetidattribute).toBe(false);
  });
  it("LookupTable(2) requires lookup column + target id attribute", () => {
    const r = tableConfigVisibility(2).required!;
    expect(r.asx_lookupcolumnlogicalname).toBe(true);
    expect(r.asx_lookuptargetidattribute).toBe(true);
  });
  it("non-LookupTable clears required for lookup fields", () => {
    for (const t of [1, 3]) {
      const r = tableConfigVisibility(t).required!;
      expect(r.asx_lookupcolumnlogicalname).toBe(false);
      expect(r.asx_lookuptargetidattribute).toBe(false);
    }
  });
});
