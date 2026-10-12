import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { renderWithFluent, makeGroup } from "./domFixtures";
import { FiresWhenEditor } from "../../src/editor/ui/inspectors/FiresWhenEditor";
import { always } from "../../src/editor/model/firesWhen";
import type { FiresWhenGroup } from "../../src/editor/model/types";

const outcomes = [
  makeGroup({ id: "o1", name: "High value", isExecutionCondition: false }),
  makeGroup({ id: "o2", name: "At risk", isExecutionCondition: false }),
];

function tree(over: Partial<FiresWhenGroup> = {}): FiresWhenGroup {
  return { id: "root", op: "all", tests: [], groups: [], ...over };
}

function render(value: FiresWhenGroup | null, outs = outcomes) {
  const onChange = vi.fn();
  renderWithFluent(<FiresWhenEditor value={value} outcomes={outs} onChange={onChange} />);
  return { onChange, last: () => onChange.mock.calls[onChange.mock.calls.length - 1][0] as FiresWhenGroup | null };
}

describe("FiresWhenEditor", () => {
  it("shows Not set with a Set to Always button that sets an empty ALL root", () => {
    const { onChange, last } = render(null);
    expect(screen.getByText("Not set. This action never runs.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run always" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(last()).toMatchObject({ op: "all", tests: [], groups: [] });
  });

  it("shows Always, when the rule runs for an empty ALL root", () => {
    render(always());
    expect(screen.getByText("Always, when the rule runs")).toBeInTheDocument();
    expect(screen.queryByText("Add a test, or remove this group.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run always" })).toBeNull();
  });

  it("+ Add test adds a test of the first outcome, expected true", () => {
    const { last } = render(tree());
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    expect(last()!.tests).toEqual([expect.objectContaining({ outcomeId: "o1", expected: true })]);
    expect(last()!.op).toBe("all");
  });

  it("toggles the root to ANY", () => {
    const { last } = render(tree({ tests: [{ id: "t1", outcomeId: "o1", expected: true }] }));
    expect(screen.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Any" }));
    expect(last()).toMatchObject({ id: "root", op: "any", tests: [{ id: "t1", outcomeId: "o1", expected: true }] });
  });

  it("changes a test to is false", async () => {
    const { last } = render(tree({ tests: [{ id: "t1", outcomeId: "o1", expected: true }] }));
    const result = screen.getByRole("combobox", { name: "Result" });
    expect(result).toHaveTextContent("is true");
    fireEvent.click(result);
    fireEvent.click(await screen.findByRole("option", { name: "is false" }));
    expect(last()!.tests).toEqual([{ id: "t1", outcomeId: "o1", expected: false }]);
  });

  it("changes a test's outcome", async () => {
    const { last } = render(tree({ tests: [{ id: "t1", outcomeId: "o1", expected: true }] }));
    const outcome = screen.getByRole("combobox", { name: "Outcome" });
    expect(outcome).toHaveTextContent("High value");
    fireEvent.click(outcome);
    fireEvent.click(await screen.findByRole("option", { name: "At risk" }));
    expect(last()!.tests).toEqual([{ id: "t1", outcomeId: "o2", expected: true }]);
  });

  it("removes a test", () => {
    const { last } = render(tree({ tests: [{ id: "t1", outcomeId: "o1", expected: true }, { id: "t2", outcomeId: "o2", expected: false }] }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove test" })[0]);
    expect(last()!.tests).toEqual([{ id: "t2", outcomeId: "o2", expected: false }]);
  });

  it("+ Add group under an ALL root adds an empty ANY subgroup", () => {
    const { last } = render(tree());
    fireEvent.click(screen.getByRole("button", { name: "Add group" }));
    expect(last()!.groups).toEqual([expect.objectContaining({ op: "any", tests: [], groups: [] })]);
  });

  it("+ Add group under an ANY root adds an empty ALL subgroup", () => {
    const { last } = render(tree({ op: "any" }));
    fireEvent.click(screen.getByRole("button", { name: "Add group" }));
    expect(last()!.groups).toEqual([expect.objectContaining({ op: "all", tests: [], groups: [] })]);
  });

  it("+ Add group inside an ANY subgroup adds an ALL group under it", () => {
    const sub: FiresWhenGroup = { id: "sub", op: "any", tests: [{ id: "t1", outcomeId: "o1", expected: true }], groups: [] };
    const { last } = render(tree({ groups: [sub] }));
    const card = screen.getByRole("group", { name: "Subgroup 1" });
    fireEvent.click(within(card).getByRole("button", { name: "Add group" }));
    expect(last()!.groups[0]).toMatchObject({ id: "sub", op: "any" });
    expect(last()!.groups[0].groups).toEqual([expect.objectContaining({ op: "all", tests: [], groups: [] })]);
  });

  it("toggles a subgroup's own op", () => {
    const sub: FiresWhenGroup = { id: "sub", op: "any", tests: [], groups: [] };
    const { last } = render(tree({ groups: [sub] }));
    const card = screen.getByRole("group", { name: "Subgroup 1" });
    fireEvent.click(within(card).getByRole("radio", { name: "All" }));
    expect(last()!.groups).toEqual([{ id: "sub", op: "all", tests: [], groups: [] }]);
  });

  it("Remove group drops the subgroup", () => {
    const sub: FiresWhenGroup = { id: "sub", op: "any", tests: [{ id: "t1", outcomeId: "o1", expected: true }], groups: [] };
    const { last } = render(tree({ tests: [{ id: "t0", outcomeId: "o2", expected: true }], groups: [sub] }));
    fireEvent.click(screen.getByRole("button", { name: "Remove group" }));
    expect(last()).toEqual({ id: "root", op: "all", tests: [{ id: "t0", outcomeId: "o2", expected: true }], groups: [] });
  });

  it("an empty ANY root asks for a test or ALL, since the root can't be removed", () => {
    render(tree({ op: "any" }));
    expect(screen.getByText("Add a test, or switch to All to run every time the rule runs.")).toBeInTheDocument();
    expect(screen.queryByText("Add a test, or remove this group.")).toBeNull();
    expect(screen.queryByText("Always, when the rule runs")).toBeNull();
  });

  it("an empty subgroup asks for a test", () => {
    render(tree({ tests: [{ id: "t0", outcomeId: "o1", expected: true }], groups: [{ id: "sub", op: "any", tests: [], groups: [] }] }));
    const card = screen.getByRole("group", { name: "Subgroup 1" });
    expect(within(card).getByText("Add a test, or remove this group.")).toBeInTheDocument();
  });

  it("numbers sibling subgroups so each has its own name", () => {
    const sub = (id: string): FiresWhenGroup => ({ id, op: "any", tests: [{ id: `${id}-t`, outcomeId: "o1", expected: true }], groups: [] });
    render(tree({ groups: [sub("s1"), sub("s2")] }));
    expect(screen.getByRole("group", { name: "Subgroup 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Subgroup 2" })).toBeInTheDocument();
  });

  it("hides + Add test and + Add group when the rule has no outcomes and says why", () => {
    render(tree(), []);
    expect(screen.queryByRole("button", { name: "Add test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add group" })).toBeNull();
    expect(screen.getByText("Add an outcome to test it here.")).toBeInTheDocument();
  });

  it("never changes the tree it was given: every edit hands back a new one", async () => {
    const deepFreeze = <T,>(o: T): T => {
      Object.values(o as object).forEach((v) => { if (v && typeof v === "object") deepFreeze(v); });
      return Object.freeze(o);
    };
    const input = deepFreeze(tree({
      tests: [{ id: "t0", outcomeId: "o1", expected: true }],
      groups: [{ id: "sub", op: "any", tests: [{ id: "t1", outcomeId: "o2", expected: true }], groups: [] }],
    }));
    const before = JSON.parse(JSON.stringify(input));
    const { onChange } = render(input);
    const root = () => screen.getAllByRole("radio", { name: "Any" })[0];
    const card = () => screen.getByRole("group", { name: "Subgroup 1" });

    fireEvent.click(root());                                                          // toggle the root
    fireEvent.click(within(card()).getByRole("radio", { name: "All" }));             // toggle a subgroup
    fireEvent.click(screen.getAllByRole("button", { name: "Add test" })[0]);        // add a test (root)
    fireEvent.click(within(card()).getByRole("button", { name: "Add test" }));      // add a test (subgroup)
    fireEvent.click(screen.getAllByRole("button", { name: "Remove test" })[0]);       // remove a test (root)
    fireEvent.click(within(card()).getByRole("button", { name: "Remove test" }));     // remove a test (subgroup)
    fireEvent.click(screen.getAllByRole("button", { name: "Add group" })[0]);       // add a group (root)
    fireEvent.click(within(card()).getByRole("button", { name: "Add group" }));     // add a group (subgroup)
    fireEvent.click(screen.getByRole("button", { name: "Remove group" }));            // remove a group
    fireEvent.click(screen.getAllByRole("combobox", { name: "Outcome" })[0]);         // change an outcome
    fireEvent.click(await screen.findByRole("option", { name: "At risk" }));
    fireEvent.click(within(card()).getByRole("combobox", { name: "Result" }));        // change expected (subgroup)
    fireEvent.click(await screen.findByRole("option", { name: "is false" }));

    expect(onChange).toHaveBeenCalledTimes(11);
    for (const [next] of onChange.mock.calls) expect(next).not.toBe(input);
    expect(input).toEqual(before);
  });

  it("shows (missing outcome) for a test whose outcome is gone, and lets it be repointed", async () => {
    const { last } = render(tree({ tests: [{ id: "t1", outcomeId: "gone", expected: true }] }));
    const outcome = screen.getByRole("combobox", { name: "Outcome" });
    expect(outcome).toHaveTextContent("(missing outcome)");
    fireEvent.click(outcome);
    fireEvent.click(await screen.findByRole("option", { name: "High value" }));
    expect(last()!.tests).toEqual([{ id: "t1", outcomeId: "o1", expected: true }]);
  });

  it("lists an unnamed outcome as (unnamed outcome)", () => {
    render(tree({ tests: [{ id: "t1", outcomeId: "o3", expected: true }] }),
      [...outcomes, makeGroup({ id: "o3", name: "", isExecutionCondition: false })]);
    expect(screen.getByRole("combobox", { name: "Outcome" })).toHaveTextContent("(unnamed outcome)");
  });
});
