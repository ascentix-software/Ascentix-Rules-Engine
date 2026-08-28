import { describe, it, expect, vi } from "vitest";
import { createMockXrm } from "../mockXrm";
import { GRID } from "../../src/authoring/visibility";
import { applyMap, registerCondition, registerAction, registerTableConfig } from "../../src/authoring/index";

// asx_conditiontype: FieldComparison=1, RowCount=2, RegexMatch=3
// asx_comparisonvaluesource: Literal=1, FieldReference=2
// asx_actiontype: SetVisible=1, SetRequired=2, ShowMessage=3, Block=4, CreateRecord=5
// asx_tableconfigtype: RootTable=1, LookupTable=2, ChildTable=3

describe("applyMap", () => {
  it("applies controls + sections through the adapter", () => {
    const xrm = createMockXrm({ tableLogicalName: "asx_rulecondition", recordId: null,
      sections: ["comparison", "rowcount"],
      attributes: { asx_minexpectedrows: { type: "integer", value: null, control: true } } });
    applyMap(xrm, { controls: { asx_minexpectedrows: false }, sections: { rowcount: false } });
    expect(xrm.getControlVisible("asx_minexpectedrows")).toBe(false);
    expect(xrm.sectionVisibility().rowcount).toBe(false);
  });
});

describe("registerCondition", () => {
  it("applies on load and re-applies on driving-field change", () => {
    const xrm = createMockXrm({ tableLogicalName: "asx_rulecondition", recordId: null,
      sections: ["comparison", "rowcount"],
      attributes: {
        asx_conditiontype: { type: "optionset", value: 2, control: true },          // RowCount=2
        asx_comparisonvaluesource: { type: "optionset", value: 1, control: true },  // Literal=1
        asx_minexpectedrows: { type: "integer", value: null, control: true },
        asx_comparisoncolumn: { type: "string", value: null, control: true },
      } });
    registerCondition(xrm);
    expect(xrm.getControlVisible("asx_minexpectedrows")).toBe(true);   // RowCount on load
    (xrm as any).__setValue("asx_conditiontype", 1);                   // FieldComparison=1
    xrm.fireOnChange("asx_conditiontype");
    expect(xrm.getControlVisible("asx_minexpectedrows")).toBe(false);  // recomputed
    expect(xrm.getControlVisible("asx_comparisoncolumn")).toBe(true);
  });

  // Contract-locking test: numeric getValue() drives visibility correctly end-to-end.
  // This ensures the regression (string label comparison) cannot silently re-appear.
  it("numeric optionset value drives correct visibility (contract lock)", () => {
    const xrm = createMockXrm({ tableLogicalName: "asx_rulecondition", recordId: null,
      sections: ["comparison", "rowcount"],
      attributes: {
        asx_conditiontype: { type: "optionset", value: 1, control: true },          // FieldComparison=1
        asx_comparisonvaluesource: { type: "optionset", value: 2, control: true },  // FieldReference=2
        asx_comparisoncolumn: { type: "string", value: null, control: true },
        asx_comparisonoperator: { type: "optionset", value: null, control: true },
        asx_comparisonvalue: { type: "string", value: null, control: true },
        asx_comparisonvaluecolumn: { type: "string", value: null, control: true },
        asx_comparisonvaluenode: { type: "string", value: null, control: true },
        asx_minexpectedrows: { type: "integer", value: null, control: true },
        asx_maxexpectedrows: { type: "integer", value: null, control: true },
      } });
    registerCondition(xrm);
    // FieldComparison+FieldReference: comparison section visible, ref controls visible
    expect(xrm.sectionVisibility().comparison).toBe(true);
    expect(xrm.sectionVisibility().rowcount).toBe(false);
    expect(xrm.getControlVisible("asx_comparisoncolumn")).toBe(true);
    expect(xrm.getControlVisible("asx_comparisonvalue")).toBe(false);     // ref overrides
    expect(xrm.getControlVisible("asx_comparisonvaluecolumn")).toBe(true);
    expect(xrm.getControlVisible("asx_comparisonvaluenode")).toBe(true);
    expect(xrm.getControlVisible("asx_minexpectedrows")).toBe(false);
  });
});

describe("registerAction", () => {
  it("applies on load and recomputes on actiontype change", () => {
    const xrm = createMockXrm({ tableLogicalName: "asx_ruleaction", recordId: null, sections: [],
      attributes: {
        asx_actiontype: { type: "optionset", value: 3, control: true },  // ShowMessage=3
        asx_message: { type: "string", value: null, control: true },
        asx_targettable: { type: "lookup", value: null, control: true },
      } });
    registerAction(xrm);
    expect(xrm.getControlVisible("asx_message")).toBe(true);       // ShowMessage
    expect(xrm.getControlVisible("asx_targettable")).toBe(false);
    (xrm as any).__setValue("asx_actiontype", 5);                  // CreateRecord=5
    xrm.fireOnChange("asx_actiontype");
    expect(xrm.getControlVisible("asx_targettable")).toBe(true);   // recomputed
    expect(xrm.getControlVisible("asx_message")).toBe(false);
  });
});

describe("registerTableConfig", () => {
  it("applies on load and recomputes on tableconfigtype change", () => {
    const xrm = createMockXrm({ tableLogicalName: "asx_tableconfig", recordId: null, sections: [],
      attributes: {
        asx_tableconfigtype: { type: "optionset", value: 2, control: true },  // LookupTable=2
        asx_lookupcolumnlogicalname: { type: "string", value: null, control: true },
        asx_childlinkfield: { type: "string", value: null, control: true },
      } });
    registerTableConfig(xrm);
    expect(xrm.getControlVisible("asx_lookupcolumnlogicalname")).toBe(true);  // LookupTable
    expect(xrm.getControlVisible("asx_childlinkfield")).toBe(false);
    (xrm as any).__setValue("asx_tableconfigtype", 3);                        // ChildTable=3
    xrm.fireOnChange("asx_tableconfigtype");
    expect(xrm.getControlVisible("asx_childlinkfield")).toBe(true);  // recomputed
    expect(xrm.getControlVisible("asx_lookupcolumnlogicalname")).toBe(false);
  });
});

// A subgrid is a control with NO attribute. Gating control writes on hasAttribute made
// the RowCount search-criteria grid a permanent no-op on the real form (it showed for
// every condition type). Visibility must be gated on controlExists; required level,
// which is meaningless without an attribute, stays gated on hasAttribute.
describe("attribute-less controls (subgrids)", () => {
  const conditionForm = (conditionType: number) =>
    createMockXrm({ tableLogicalName: "asx_rulecondition", recordId: null,
      sections: ["comparison", "rowcount"],
      controlsWithoutAttributes: [GRID.conditionSearchCriteria],
      attributes: {
        asx_conditiontype: { type: "optionset", value: conditionType, control: true },
        asx_comparisonvaluesource: { type: "optionset", value: 1, control: true },
        asx_minexpectedrows: { type: "integer", value: null, control: true },
        asx_comparisoncolumn: { type: "string", value: null, control: true },
      } });

  it("the mock reports a subgrid as a control with no attribute", () => {
    const xrm = conditionForm(2);
    expect(xrm.controlExists(GRID.conditionSearchCriteria)).toBe(true);
    expect(xrm.hasAttribute(GRID.conditionSearchCriteria)).toBe(false);
  });

  it("RowCount(2) shows the search-criteria subgrid", () => {
    const xrm = conditionForm(2);
    registerCondition(xrm);
    expect(xrm.getControlVisible(GRID.conditionSearchCriteria)).toBe(true);
  });

  it("FieldComparison(1) hides the search-criteria subgrid", () => {
    const xrm = conditionForm(1);
    registerCondition(xrm);
    expect(xrm.getControlVisible(GRID.conditionSearchCriteria)).toBe(false);
  });

  it("RegexMatch(3) hides the subgrid, and a change back to RowCount re-shows it", () => {
    const xrm = conditionForm(3);
    registerCondition(xrm);
    expect(xrm.getControlVisible(GRID.conditionSearchCriteria)).toBe(false);
    (xrm as any).__setValue("asx_conditiontype", 2);   // RowCount=2
    xrm.fireOnChange("asx_conditiontype");
    expect(xrm.getControlVisible(GRID.conditionSearchCriteria)).toBe(true);
  });

  it("never writes a required level for a control that has no attribute", () => {
    const xrm = createMockXrm({ tableLogicalName: "asx_rulecondition", recordId: null,
      sections: [], controlsWithoutAttributes: [GRID.conditionSearchCriteria],
      attributes: { asx_minexpectedrows: { type: "integer", value: null, control: true } } });
    const spy = vi.spyOn(xrm, "setRequiredLevel");
    applyMap(xrm, {
      controls: { [GRID.conditionSearchCriteria]: true },
      sections: {},
      required: { [GRID.conditionSearchCriteria]: true, asx_minexpectedrows: true },
    });
    // the real attribute is set; the subgrid is skipped entirely
    expect(spy.mock.calls).toEqual([["asx_minexpectedrows", "required"]]);
    expect(xrm.getRequiredLevel("asx_minexpectedrows")).toBe("required");
    // ...while its visibility still gets applied
    expect(xrm.getControlVisible(GRID.conditionSearchCriteria)).toBe(true);
  });
});
