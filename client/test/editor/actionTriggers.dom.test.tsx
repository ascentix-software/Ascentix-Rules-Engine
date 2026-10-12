import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { makeGraph, makeAction } from "./domFixtures";
import { fakeMetadata, renderWithMeta } from "./metaFixtures";
import { actionRunsOn, defaultActionType } from "../../src/editor/model/actionTriggers";
import { hintIssues } from "../../src/editor/validation";
import { addAction } from "../../src/editor/model/reducer";
import { ActionInspector } from "../../src/editor/ui/inspectors/ActionInspector";

const UPDATE = [4];
const FORM = [2];
const ON_DEMAND = [3];

describe("actionRunsOn", () => {
  it("form changes and messages need On form, or On demand (its dry-run API returns them)", () => {
    for (const t of ["SetVisible", "SetRequired", "ShowMessage"] as const) {
      expect(actionRunsOn(t, UPDATE)).toBe(false);
      expect(actionRunsOn(t, [1, 4, 5])).toBe(false);
      expect(actionRunsOn(t, [4, 2])).toBe(true);
      expect(actionRunsOn(t, ON_DEMAND)).toBe(true);
    }
  });

  it("writes need a save or On demand, not the form", () => {
    expect(actionRunsOn("UpdateRecord", FORM)).toBe(false);
    expect(actionRunsOn("UpdateRecord", UPDATE)).toBe(true);
    expect(actionRunsOn("CreateRecord", ON_DEMAND)).toBe(true);
    expect(actionRunsOn("DeleteRecord", [5])).toBe(true);
  });

  it("Block runs under every trigger, and a rule with no triggers restricts nothing", () => {
    for (const t of [1, 2, 3, 4, 5]) expect(actionRunsOn("Block", [t])).toBe(true);
    expect(actionRunsOn("ShowMessage", [])).toBe(true);
  });
});

describe("a new action's type", () => {
  it("is a message on a form rule and a Block otherwise", () => {
    expect(defaultActionType([2, 4])).toBe("ShowMessage");
    expect(defaultActionType(UPDATE)).toBe("Block");
    const g = makeGraph();
    g.rule.triggers = UPDATE;
    expect(addAction(g).actions[0].actionType).toBe("Block");
  });
});

describe("HINT_ACTION_NEVER_RUNS", () => {
  const ruleWith = (triggers: number[], action = makeAction({ id: "a1", actionType: "ShowMessage", message: "Hi" })) => {
    const g = makeGraph({ actions: [action] });
    g.rule.triggers = triggers;
    return g;
  };

  it("warns about a form message on an update-only rule, telling how to fix it", () => {
    const hint = hintIssues(ruleWith(UPDATE)).find((h) => h.code === "HINT_ACTION_NEVER_RUNS");
    expect(hint).toMatchObject({ nodeId: "a1", severity: "Warning" });
    expect(hint!.message).toBe("This action only works on the form. Add On form to the triggers, or choose another type.");
  });

  it("warns about a write on a form-only rule", () => {
    const write = makeAction({ id: "a1", actionType: "UpdateRecord", targetNodeId: "root" });
    expect(hintIssues(ruleWith(FORM, write)).find((h) => h.code === "HINT_ACTION_NEVER_RUNS")?.message)
      .toMatch(/^This action only runs when a record is saved or run on demand\./);
  });

  it("stays quiet when the triggers fit, or the action is off", () => {
    expect(hintIssues(ruleWith([4, 2])).some((h) => h.code === "HINT_ACTION_NEVER_RUNS")).toBe(false);
    const off = makeAction({ id: "a1", actionType: "ShowMessage", message: "Hi", isActive: false });
    expect(hintIssues(ruleWith(UPDATE, off)).some((h) => h.code === "HINT_ACTION_NEVER_RUNS")).toBe(false);
  });
});

describe("ActionInspector Type", () => {
  it("offers types that can't run under the triggers disabled, with the reason; the current type stays selectable", () => {
    const action = makeAction({ id: "a1", actionType: "ShowMessage", message: "Hi" });
    renderWithMeta(
      <ActionInspector action={action} ruleTable="account" tableConfigs={{}} outcomes={[]} triggers={UPDATE}
        onPatch={vi.fn()} onAddTranslation={vi.fn()} onUpdateTranslation={vi.fn()} onRemoveTranslation={vi.fn()} />,
      fakeMetadata({ account: [] }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: /^Type/ }));
    const show = screen.getByRole("option", { name: /^Show message/ });
    expect(show).not.toHaveAttribute("aria-disabled", "true");
    const required = screen.getByRole("option", { name: /^Set required/ });
    expect(required).toHaveAttribute("aria-disabled", "true");
    expect(required).toHaveTextContent("Needs On form");
    expect(screen.getByRole("option", { name: /^Update record/ })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: /^Block/ })).not.toHaveAttribute("aria-disabled", "true");
  });
});
