import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input, Button } from "@fluentui/react-components";
import { renderWithFluent, makeGraph, makeGroup, makeAction } from "./domFixtures";
import {
  InfoTip, InfoField, Field, MatchToggle, SegmentedToggle, EffectPill, toMatch, fromMatch,
} from "../../src/editor/ui/primitives";
import { DialogShell } from "../../src/editor/ui/DialogShell";
import { InspectorSection } from "../../src/editor/ui/InspectorShell";
import { useNotify } from "../../src/editor/ui/notify";
import { buildIssues } from "../../src/editor/ui/useIssues";
import type { ConditionNode } from "../../src/editor/model/types";

describe("InfoTip", () => {
  it("is a focusable button named after its label", async () => {
    renderWithFluent(<InfoTip text="Help text" label="Triggers" />);
    const btn = screen.getByRole("button", { name: "More info: Triggers" });
    await userEvent.tab();
    expect(btn).toHaveFocus();
  });
});

describe("InfoField", () => {
  it("keeps the tip out of the control's accessible name", () => {
    renderWithFluent(<InfoField label="Name" info="Shown in pickers" required><Input /></InfoField>);
    expect(screen.getByRole("textbox", { name: /^Name/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox").getAttribute("aria-labelledby") ?? "").not.toContain("More info");
    const label = document.querySelector("label")!;
    expect(label.textContent).not.toContain("More info");
    expect(screen.getByRole("button", { name: "More info: Name" })).toBeInTheDocument();
  });
});

describe("Field", () => {
  it("puts info behind an icon and shows hint only as an error", () => {
    renderWithFluent(<Field label="Name" info="Explains" hint="Enter a name."><input aria-label="Name" /></Field>);
    // The text only lives in the tooltip (the icon's description), never inline under the field.
    expect(screen.getByText("Explains").closest("[role=tooltip]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "More info: Name" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name.");
  });
});

describe("MatchToggle", () => {
  it("is a radiogroup of All / Any and moves with arrow keys", () => {
    const onChange = vi.fn();
    renderWithFluent(<MatchToggle value="all" onChange={onChange} ariaLabel="Match" />);
    const group = screen.getByRole("radiogroup", { name: "Match" });
    const all = screen.getByRole("radio", { name: "All" });
    expect(group).toBeInTheDocument();
    expect(all).toHaveAttribute("aria-checked", "true");
    expect(all).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Any" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("any");
  });

  it("renders a neutral Match all / Match any badge in display mode", () => {
    renderWithFluent(<><MatchToggle mode="display" value="all" /><MatchToggle mode="display" value="any" /></>);
    expect(screen.getByText("Match all")).toBeInTheDocument();
    expect(screen.getByText("Match any")).toBeInTheDocument();
  });

  it("maps to the model's logical operator", () => {
    expect(toMatch("And")).toBe("all");
    expect(toMatch("Or")).toBe("any");
    expect(fromMatch("any")).toBe("Or");
    expect(fromMatch("all")).toBe("And");
  });
});

describe("SegmentedToggle", () => {
  it("selects on click", () => {
    const onChange = vi.fn();
    renderWithFluent(<SegmentedToggle ariaLabel="Show times in" value="utc" onChange={onChange}
      options={[{ value: "utc", label: "UTC" }, { value: "local", label: "Local" }]} />);
    fireEvent.click(screen.getByRole("radio", { name: "Local" }));
    expect(onChange).toHaveBeenCalledWith("local");
  });
});

describe("EffectPill", () => {
  it.each([
    [{ actionType: "Block" as const }, "Blocks save"],
    [{ actionType: "ShowMessage" as const, targetColumn: "x" }, "Holds form save"],
    [{ actionType: "ShowMessage" as const }, "Form message"],
    [{ actionType: "SetVisible" as const }, "Form change"],
    [{ actionType: "UpdateRecord" as const }, "Writes data"],
  ])("labels %o as %s", (over, label) => {
    renderWithFluent(<EffectPill action={makeAction(over)} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("DialogShell", () => {
  it("renders title, a close button and the actions", () => {
    const onClose = vi.fn();
    renderWithFluent(
      <DialogShell open title="Delete it?" onClose={onClose} actions={<Button>Cancel</Button>}>
        <p>Body</p>
      </DialogShell>,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete it?");
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("InspectorSection", () => {
  beforeEach(() => sessionStorage.clear());

  it("shows the summary only while collapsed and remembers the open state", () => {
    const { unmount } = renderWithFluent(
      <InspectorSection id="evaluation" title="Evaluation" summary="As system · UTC"><span>Body</span></InspectorSection>,
    );
    expect(screen.getByText("As system · UTC")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Evaluation/ }));
    expect(screen.queryByText("As system · UTC")).toBeNull();
    expect(sessionStorage.getItem("asx.inspector.evaluation")).toBe("1");
    unmount();
    renderWithFluent(<InspectorSection id="evaluation" title="Evaluation" summary="x"><span>Body</span></InspectorSection>);
    expect(screen.getByText("Body")).toBeVisible();
  });
});

describe("useNotify", () => {
  function Probe({ onUndo }: { onUndo(): void }) {
    const notify = useNotify();
    return <><button onClick={() => notify.success("Saved")}>s</button><button onClick={() => notify.undo("Condition deleted", onUndo)}>u</button></>;
  }

  it("shows a toast once, even under nested providers", async () => {
    renderWithFluent(<Probe onUndo={() => {}} />);
    act(() => { fireEvent.click(screen.getByText("s")); });
    await waitFor(() => expect(screen.getAllByText("Saved")).toHaveLength(1));
  });

  it("offers Undo on an undo toast", async () => {
    const onUndo = vi.fn();
    renderWithFluent(<Probe onUndo={onUndo} />);
    act(() => { fireEvent.click(screen.getByText("u")); });
    const undo = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalled();
  });
});

describe("buildIssues", () => {
  const cond = (over: Partial<ConditionNode>): ConditionNode => ({
    id: "c1", name: "", tableConfigId: "n1", conditionType: "FieldComparison",
    comparisonColumn: "probability", comparisonOperator: 1, comparisonValue: "5", valueSource: 1,
    comparisonValueNodeId: null, comparisonValueColumn: null, minExpectedRows: null, maxExpectedRows: null,
    expression: null, filter: null, ...over,
  } as ConditionNode);
  const graph = makeGraph({
    validationGroups: [makeGroup({ id: "o1", name: "Approval gaps", isExecutionCondition: false, conditions: [cond({})] })],
    actions: [makeAction({ id: "a1", actionType: "Block", message: "No" })],
  });

  it("paths server issues and keeps them, marked stale", () => {
    const check = {
      graphJson: "{}", checkedAt: new Date(),
      issues: [
        { severity: "Error", code: "X", message: "Bad", target: { kind: "Condition", id: "C1" } },
        { severity: "Warning", code: "W", message: "Hm", target: { kind: "Action", id: "a1" } },
      ],
    };
    const issues = buildIssues(graph, check, { stale: true, columnLabel: () => "Probability" });
    expect(issues[0]).toMatchObject({ severity: "Error", path: "Approval gaps › Probability", stale: true, target: { kind: "condition", id: "c1" } });
    expect(issues[1]).toMatchObject({ severity: "Warning", path: "Action 1 · Block save" });
  });

  it("adds live client hints", () => {
    const g = makeGraph({ validationGroups: [makeGroup({ id: "o1", name: "Gaps", isExecutionCondition: false,
      conditions: [cond({ comparisonValue: null })] })] });
    const issues = buildIssues(g, null, { stale: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "HINT_MISSING_FIELD", target: { kind: "condition", id: "c1" }, stale: false });
  });
});
