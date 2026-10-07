import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { IssuesDrawer, IssuesLiveRegion } from "../../src/editor/ui/issues/IssuesDrawer";
import { IssuesButton } from "../../src/editor/ui/issues/IssuesButton";
import { IssueIcon } from "../../src/editor/ui/issues/IssueIcon";
import type { Issue, IssuesState } from "../../src/editor/ui/useIssues";

const issue = (over: Partial<Issue>): Issue => ({
  id: "i1", severity: "Error", code: "CONDITION_VALUE_REQUIRED", message: "Enter a value to compare against.",
  target: { kind: "condition", id: "c1" }, path: "Approval gaps › Probability", stale: false, source: "server", ...over,
});

function state(issues: Issue[], over: Partial<IssuesState> = {}): IssuesState {
  return {
    issues, byTarget: new Map(), stale: false, checkedAt: new Date(),
    errors: issues.filter((i) => i.severity === "Error"),
    warnings: issues.filter((i) => i.severity === "Warning"),
    ...over,
  };
}

describe("IssuesLiveRegion", () => {
  it("is always present as a status live region, even with no issues", () => {
    renderWithFluent(<IssuesLiveRegion state={state([], { checkedAt: null })} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("announces the counts when a check completes", () => {
    renderWithFluent(<IssuesLiveRegion state={state([issue({}), issue({ id: "w", severity: "Warning" })])} />);
    expect(screen.getByRole("status")).toHaveTextContent("1 error, 1 warning");
  });
});

describe("IssuesDrawer", () => {
  it("groups errors and warnings, with path, message and code", () => {
    renderWithFluent(<IssuesDrawer open state={state([issue({}), issue({ id: "w", severity: "Warning", message: "Unused." })])}
      onClose={() => {}} onGo={() => {}} />);
    expect(screen.getByText("Must fix to publish · 1")).toBeInTheDocument();
    expect(screen.getByText("Warnings · 1")).toBeInTheDocument();
    expect(screen.getAllByText("Approval gaps › Probability")).toHaveLength(2);
    expect(screen.getAllByText("CONDITION_VALUE_REQUIRED")).toHaveLength(2);
  });

  it("says when results are out of date, and a row goes to its target", () => {
    const onGo = vi.fn();
    const i = issue({});
    renderWithFluent(<IssuesDrawer open state={state([i], { stale: true })} onClose={() => {}} onGo={onGo} />);
    expect(screen.getByText("You've edited since this check. Results may be out of date.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Approval gaps › Probability/ }));
    expect(onGo).toHaveBeenCalledWith(i);
  });
});

describe("IssuesButton", () => {
  it("renders nothing without issues", () => {
    const { container } = renderWithFluent(<IssuesButton state={state([])} open={false} onToggle={() => {}} />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("counts errors and warnings, and marks a stale check", () => {
    renderWithFluent(<IssuesButton open={false} onToggle={() => {}}
      state={state([issue({}), issue({ id: "w", severity: "Warning" })], { stale: true })} />);
    const btn = screen.getByRole("button", { name: "Issues: 1 error, 1 warning, out of date" });
    expect(btn).toHaveTextContent("1 error");
    expect(btn).toHaveTextContent("out of date");
  });
});

describe("IssueIcon", () => {
  it("is one focusable icon named by the first message, +N more", () => {
    const onOpen = vi.fn();
    renderWithFluent(<IssueIcon issues={[issue({}), issue({ id: "2", message: "Other" })]} onOpen={onOpen} />);
    const btn = screen.getByRole("button", { name: "Enter a value to compare against. +1 more" });
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalled();
  });
});
