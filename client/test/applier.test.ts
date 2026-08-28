import { describe, it, expect } from "vitest";
import { Applier, snapshotBaseline } from "../src/applier";
import { createMockXrm, MockState } from "./mockXrm";
import type { FiredAction } from "../src/contract";

function fired(p: Partial<FiredAction>): FiredAction {
  return { ruleId: "r1", actionType: "SetVisible", fireOn: "OnMatch", targetColumn: null,
    value: null, message: null, severity: null, targetTable: null, ...p };
}

function setup(attrs: MockState["attributes"], universe: string[]) {
  const xrm = createMockXrm({ tableLogicalName: "account", recordId: null, attributes: attrs });
  const baseline = snapshotBaseline(xrm, universe);
  return { xrm, applier: new Applier(xrm, baseline, universe) };
}

describe("Applier", () => {
  it("SetVisible toggles control visibility", () => {
    const { xrm, applier } = setup(
      { telephone1: { type: "string", value: null, control: true, visible: true } }, ["telephone1"]);
    applier.apply([fired({ actionType: "SetVisible", targetColumn: "telephone1", value: false })]);
    expect(xrm.getControlVisible("telephone1")).toBe(false);
  });

  it("SetRequired sets required level", () => {
    const { xrm, applier } = setup(
      { creditlimitapprovedby: { type: "lookup", value: null, control: true, required: "none" } },
      ["creditlimitapprovedby"]);
    applier.apply([fired({ actionType: "SetRequired", targetColumn: "creditlimitapprovedby", value: true })]);
    expect(xrm.getRequiredLevel("creditlimitapprovedby")).toBe("required");
  });

  it("resets to baseline when an action stops firing", () => {
    const { xrm, applier } = setup(
      { telephone1: { type: "string", value: null, control: true, visible: true } }, ["telephone1"]);
    applier.apply([fired({ actionType: "SetVisible", targetColumn: "telephone1", value: false })]);
    expect(xrm.getControlVisible("telephone1")).toBe(false);
    applier.apply([]); // nothing fires now → reset to baseline (visible)
    expect(xrm.getControlVisible("telephone1")).toBe(true);
  });

  it("field-level Block shows an inline notification only (no banner; platform rolls it up on save)", () => {
    const { xrm, applier } = setup(
      { creditlimit: { type: "money", value: 1, control: true } }, []);
    applier.apply([fired({ actionType: "Block", fireOn: "OnNoMatch", targetColumn: "creditlimit",
      message: "Too low", severity: "Error" })]);
    expect(xrm.controlNotifications()).toEqual([{ name: "creditlimit", message: "Too low", uid: "r1:creditlimit:0" }]);
    expect(xrm.formNotifications()).toEqual([]);
  });

  it("form-level Block uses a form notification", () => {
    const { xrm, applier } = setup({}, []);
    applier.apply([fired({ actionType: "Block", fireOn: "OnNoMatch", targetColumn: null,
      message: "Invalid", severity: "Error" })]);
    expect(xrm.formNotifications()).toEqual([{ message: "Invalid", level: "ERROR", uid: "r1:form:0" }]);
  });

  it("Block with a targetColumn not on the form falls back to a form notification", () => {
    const { xrm, applier } = setup({}, []); // no control for "offform"
    applier.apply([fired({ actionType: "Block", fireOn: "OnNoMatch", targetColumn: "offform",
      message: "Nope", severity: "Error" })]);
    expect(xrm.formNotifications()[0].message).toBe("Nope");
  });

  it("ShowMessage uses a form notification at the mapped level", () => {
    const { xrm, applier } = setup({}, []);
    applier.apply([fired({ actionType: "ShowMessage", fireOn: "OnMatch", message: "Heads up", severity: "Warning" })]);
    expect(xrm.formNotifications()).toEqual([{ message: "Heads up", level: "WARNING", uid: "r1:form:0" }]);
  });

  it("ShowMessage with an on-form target renders inline (non-blocking), not a banner", () => {
    const { xrm, applier } = setup(
      { region: { type: "string", value: null, control: true } }, []);
    applier.apply([fired({ actionType: "ShowMessage", fireOn: "OnMatch", targetColumn: "region",
      message: "Check EU code", severity: "Warning" })]);
    expect(xrm.controlNotifications()).toEqual([{ name: "region", message: "Check EU code", uid: "r1:region:0" }]);
    expect(xrm.formNotifications()).toEqual([]);
  });

  it("ShowMessage with a target not on the form falls back to a form banner", () => {
    const { xrm, applier } = setup({}, []); // no control for "offform"
    applier.apply([fired({ actionType: "ShowMessage", fireOn: "OnMatch", targetColumn: "offform",
      message: "FYI", severity: "Warning" })]);
    expect(xrm.controlNotifications()).toEqual([]);
    expect(xrm.formNotifications()[0]).toMatchObject({ message: "FYI", level: "WARNING" });
  });

  it("ShowMessage with null severity defaults to INFO", () => {
    const { xrm, applier } = setup({}, []);
    applier.apply([fired({ actionType: "ShowMessage", fireOn: "OnMatch", message: "FYI", severity: null })]);
    expect(xrm.formNotifications()[0].level).toBe("INFO");
  });

  it("ignores CreateRecord", () => {
    const { xrm, applier } = setup({}, []);
    applier.apply([fired({ actionType: "CreateRecord", fireOn: "OnNoMatch" })]);
    expect(xrm.formNotifications()).toEqual([]);
  });

  it("clears prior notifications on the next cycle", () => {
    const { xrm, applier } = setup({}, []);
    applier.apply([fired({ actionType: "Block", fireOn: "OnNoMatch", targetColumn: null, message: "X", severity: "Error" })]);
    expect(xrm.formNotifications()).toHaveLength(1);
    applier.apply([]); // reset
    expect(xrm.formNotifications()).toEqual([]);
  });

  it("field-level Block (inline) coexists with no-field Block + ShowMessage banners", () => {
    const { xrm, applier } = setup(
      { creditlimit: { type: "money", value: 1, control: true } }, []);
    applier.apply([
      fired({ ruleId: "r1", actionType: "Block", fireOn: "OnNoMatch", targetColumn: "creditlimit", message: "Field bad", severity: "Error" }),
      fired({ ruleId: "r2", actionType: "Block", fireOn: "OnNoMatch", targetColumn: null, message: "No lines", severity: "Error" }),
      fired({ ruleId: "r3", actionType: "ShowMessage", fireOn: "OnMatch", message: "VIP", severity: "Information" }),
    ]);
    // field Block -> inline only; no-field Block + ShowMessage -> banners (uid carries the fired-action index)
    expect(xrm.controlNotifications().map((n) => n.uid)).toEqual(["r1:creditlimit:0"]);
    expect(xrm.formNotifications().map((n) => n.uid)).toEqual(["r2:form:1", "r3:form:2"]);
  });

  it("two form-targeted actions on the SAME rule get distinct uids (no overwrite)", () => {
    const { xrm, applier } = setup({}, []);
    applier.apply([
      fired({ ruleId: "r1", actionType: "Block", fireOn: "OnMatch", targetColumn: null, message: "Blocked", severity: "Error" }),
      fired({ ruleId: "r1", actionType: "ShowMessage", fireOn: "OnMatch", message: "Note", severity: "Warning" }),
    ]);
    const notes = xrm.formNotifications();
    expect(notes.map((n) => n.message)).toEqual(["Blocked", "Note"]);
    const uids = notes.map((n) => n.uid);
    expect(new Set(uids).size).toBe(uids.length); // distinct uids → platform won't overwrite one
  });
});

// -------------------------------------------------------------------------------------------
// ATOMICITY. apply() must never leave the form with LESS decoration than it had before a
// failed cycle. Proven live by faulting Xrm.Page.ui.setFormNotification on a real
// form: the old `reset(); then re-apply` order meant the previous cycle's blocking message was
// already gone by the time the re-apply threw, so the user was left looking at a clean form and
// concluding the record was valid. Nothing at any layer could see this before: the mock never
// threw, and no network fault can reach the apply phase (it is past the round-trip).
//
// The invariant asserted here is deliberately weaker than "nothing changed": it is "nothing the
// previous cycle established was torn down". That is what the commit order buys, and it is what
// docs/Client-Form-Library.md §5 promises ("retains the last successful cycle's state").
// -------------------------------------------------------------------------------------------
describe("Applier atomicity", () => {
  const banner = (msg: string) =>
    fired({ ruleId: "r1", actionType: "ShowMessage", fireOn: "OnMatch", targetColumn: null,
      message: msg, severity: "Error" });
  const hide = fired({ ruleId: "r1", actionType: "SetVisible", targetColumn: "telephone1", value: false });

  function established() {
    const { xrm, applier } = setup(
      { telephone1: { type: "string", value: null, control: true, visible: true } }, ["telephone1"]);
    // Cycle 1: a banner AND a hidden control, which reset() used to clear through two
    // different code paths, so both are asserted below.
    applier.apply([banner("Needs approval"), hide]);
    expect(xrm.formNotifications().map((n) => n.message)).toEqual(["Needs approval"]);
    expect(xrm.getControlVisible("telephone1")).toBe(false);
    return { xrm, applier };
  }

  it("a throw while re-issuing a notification leaves the previous cycle's banner AND control state intact", () => {
    const { xrm, applier } = established();
    xrm.__failOn("setFormNotification", "Xrm is throwing");
    // The banner is planned BEFORE the SetVisible, which is exactly the ordering that used to
    // wipe the control: reset() restored telephone1 to visible, then the banner threw and the
    // SetVisible was never re-applied.
    expect(() => applier.apply([banner("Needs approval"), hide])).toThrow("Xrm is throwing");
    expect(xrm.formNotifications().map((n) => n.message)).toEqual(["Needs approval"]);
    expect(xrm.getControlVisible("telephone1")).toBe(false);
  });

  it("a throw while re-issuing an inline note leaves the previous cycle's inline note intact", () => {
    const { xrm, applier } = setup({ creditlimit: { type: "money", value: 1, control: true } }, []);
    const inline = fired({ ruleId: "r1", actionType: "Block", fireOn: "OnNoMatch",
      targetColumn: "creditlimit", message: "Too low", severity: "Error" });
    applier.apply([inline]);
    expect(xrm.controlNotifications()).toHaveLength(1);
    xrm.__failOn("setControlNotification");
    expect(() => applier.apply([inline])).toThrow();
    expect(xrm.controlNotifications().map((n) => n.message)).toEqual(["Too low"]);
  });

  it("a throw during PLANNING leaves the form completely untouched", () => {
    const { xrm, applier } = established();
    // controlExists is read while deciding inline-vs-banner, i.e. before any mutation.
    xrm.__failOn("controlExists");
    expect(() =>
      applier.apply([fired({ ruleId: "r2", actionType: "ShowMessage", fireOn: "OnMatch",
        targetColumn: "telephone1", message: "x", severity: "Error" })]),
    ).toThrow();
    expect(xrm.formNotifications().map((n) => n.message)).toEqual(["Needs approval"]);
    expect(xrm.getControlVisible("telephone1")).toBe(false);
  });

  it("recovers on the next cycle once the fault clears, with no duplicate notification", () => {
    const { xrm, applier } = established();
    xrm.__failOn("setFormNotification");
    expect(() => applier.apply([banner("Needs approval"), hide])).toThrow();
    xrm.__clearFault();
    applier.apply([banner("Needs approval"), hide]);
    // Re-issuing a uid REPLACES it in the platform's store; a second entry would mean the
    // applier had lost track of what it had already put on the form.
    expect(xrm.formNotifications()).toEqual([
      { message: "Needs approval", level: "ERROR", uid: "r1:form:0" },
    ]);
    expect(xrm.getControlVisible("telephone1")).toBe(false);
  });

  it("a notification set before the throw is still retracted when the rule stops matching (no orphan)", () => {
    const { xrm, applier } = setup({ creditlimit: { type: "money", value: 1, control: true } }, []);
    const inline = fired({ ruleId: "r1", actionType: "Block", fireOn: "OnNoMatch",
      targetColumn: "creditlimit", message: "Too low", severity: "Error" });
    const late = fired({ ruleId: "r2", actionType: "ShowMessage", fireOn: "OnMatch",
      targetColumn: null, message: "Also", severity: "Error" });
    xrm.__failOn("setFormNotification");
    // The inline note commits, then the banner throws. The applier must have RECORDED the note
    // it managed to set, or the next cycle can never take it off again.
    expect(() => applier.apply([inline, late])).toThrow();
    expect(xrm.controlNotifications()).toHaveLength(1);
    xrm.__clearFault();
    applier.apply([]); // nothing fires now
    expect(xrm.controlNotifications()).toEqual([]);
    expect(xrm.formNotifications()).toEqual([]);
  });

  it("a successful cycle still releases what the previous one set (no retention when nothing throws)", () => {
    const { xrm, applier } = established();
    applier.apply([]);
    expect(xrm.formNotifications()).toEqual([]);
    expect(xrm.getControlVisible("telephone1")).toBe(true); // back to baseline
  });
});
