import { describe, it, expect, vi } from "vitest";
import { createMockXrm } from "./mockXrm";

describe("mock XrmAdapter", () => {
  it("reports attribute presence and value", () => {
    const xrm = createMockXrm({
      tableLogicalName: "account",
      recordId: null,
      attributes: { name: { type: "string", value: "Acme" } },
    });
    expect(xrm.hasAttribute("name")).toBe(true);
    expect(xrm.hasAttribute("missing")).toBe(false);
    expect(xrm.getValue("name")).toBe("Acme");
    expect(xrm.getAttributeType("name")).toBe("string");
  });

  it("tracks visibility and required-level changes", () => {
    const xrm = createMockXrm({
      tableLogicalName: "account", recordId: null,
      attributes: { telephone1: { type: "string", value: null, control: true, visible: true, required: "none" } },
    });
    xrm.setControlVisible("telephone1", false);
    expect(xrm.getControlVisible("telephone1")).toBe(false);
    xrm.setRequiredLevel("telephone1", "required");
    expect(xrm.getRequiredLevel("telephone1")).toBe("required");
  });

  it("records notifications and clears them", () => {
    const xrm = createMockXrm({
      tableLogicalName: "account", recordId: null,
      attributes: { creditlimit: { type: "money", value: 5, control: true } },
    });
    xrm.setControlNotification("creditlimit", "Bad", "u1");
    expect(xrm.controlNotifications()).toEqual([{ name: "creditlimit", message: "Bad", uid: "u1" }]);
    xrm.clearControlNotification("creditlimit", "u1");
    expect(xrm.controlNotifications()).toEqual([]);
    xrm.setFormNotification("Form bad", "ERROR", "f1");
    expect(xrm.formNotifications()).toEqual([{ message: "Form bad", level: "ERROR", uid: "f1" }]);
    xrm.clearFormNotification("f1");
    expect(xrm.formNotifications()).toEqual([]);
  });

  it("fires registered OnChange handlers", () => {
    const xrm = createMockXrm({
      tableLogicalName: "account", recordId: null,
      attributes: { name: { type: "string", value: "x" } },
    });
    const handler = vi.fn();
    xrm.addOnChange("name", handler);
    xrm.fireOnChange("name");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("tracks section visibility via setSectionVisible", () => {
    const xrm = createMockXrm({
      tableLogicalName: "asx_rulecondition", recordId: null,
      attributes: {}, sections: ["comparison", "rowcount"],
    });
    xrm.setSectionVisible("rowcount", false);
    expect(xrm.sectionVisibility()).toEqual({ comparison: true, rowcount: false });
  });
});
