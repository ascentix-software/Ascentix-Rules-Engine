import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { renderWithMeta, fakeMetadata } from "./metaFixtures";
import { makeGraph } from "./domFixtures";
import { RuleInspector } from "../../src/editor/ui/inspectors/RuleInspector";
import type { RuleHeader } from "../../src/editor/model/types";

function mount(ruleOver: Partial<RuleHeader> = {}, onPatch = vi.fn()) {
  const rule: RuleHeader = { ...makeGraph().rule, ...ruleOver };
  renderWithMeta(<RuleInspector rule={rule} onPatch={onPatch} />, fakeMetadata({ account: [] }));
  return { rule, onPatch };
}

const open = (title: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));

beforeEach(() => sessionStorage.clear());

describe("RuleInspector sections", () => {
  it("opens When it runs by default and collapses the others with a summary", () => {
    mount({ evaluationContext: 2 });
    expect(screen.getByRole("combobox", { name: "Triggers" })).toBeInTheDocument();
    expect(screen.getByText("Always active")).toBeInTheDocument();
    expect(screen.getByText("As system · UTC")).toBeInTheDocument();
  });

  it("shows the table as read-only text, not a disabled input", () => {
    mount();
    expect(screen.getByText(/· account · set when created/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("account")).toBeNull();
  });

  it("shows triggers as dismissible tags in one picker, with no separate badge row", () => {
    const { onPatch } = mount({ triggers: [1, 4] });
    const tags = screen.getByRole("listbox", { name: "Selected triggers" });
    expect(within(tags).getByText("On create")).toBeInTheDocument();
    // A selected tag is an option of the group; clicking it (or its ✕) removes it.
    fireEvent.click(within(tags).getByRole("option", { name: /^On create/ }));
    expect(onPatch).toHaveBeenCalledWith({ triggers: [4] });
  });

  it("asks for update columns only when On update is a trigger", () => {
    mount({ triggers: [1] });
    expect(screen.queryByRole("combobox", { name: "Also run on update when these change" })).toBeNull();
  });
});

describe("RuleInspector Active period", () => {
  it("shows the start date when the rule has one", () => {
    mount({ effectiveFrom: "2026-01-01" });
    expect(screen.getByText(/^From .*2026$/)).toBeInTheDocument();
    open("Active period");
    expect(screen.getByLabelText("Starts")).toHaveValue("2026-01-01T00:00");
  });

  it("fires onPatch with the new start on change", () => {
    const { onPatch } = mount({ effectiveFrom: "2026-01-01" });
    open("Active period");
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-02-02T17:30" } });
    expect(onPatch).toHaveBeenCalledWith({ effectiveFrom: "2026-02-02T17:30:00.000Z" });
  });

  it("shows No start limit / No end limit placeholders while empty", () => {
    mount();
    open("Active period");
    expect(screen.getByLabelText("Starts")).toHaveAttribute("placeholder", "No start limit");
    expect(screen.getByLabelText("Ends")).toHaveAttribute("placeholder", "No end limit");
  });
});

describe("RuleInspector Evaluation", () => {
  it("defaults Run as to the user who triggered it", () => {
    mount();
    open("Evaluation");
    expect(screen.getByRole("radio", { name: "The user who triggered it" })).toBeChecked();
  });

  it("patches System as evaluation context 2", () => {
    const { onPatch } = mount();
    open("Evaluation");
    fireEvent.click(screen.getByRole("radio", { name: /^System/ }));
    expect(onPatch).toHaveBeenCalledWith({ evaluationContext: 2 });
  });

  it("defaults the rule time zone to UTC", () => {
    mount();
    open("Evaluation");
    expect(screen.getByRole("combobox", { name: /Rule time zone/ })).toHaveTextContent("UTC (default)");
  });

  it("patches the chosen time zone id", async () => {
    const { onPatch } = mount();
    open("Evaluation");
    fireEvent.click(screen.getByRole("combobox", { name: /Rule time zone/ }));
    fireEvent.click(await screen.findByRole("option", { name: "(GMT-05:00) Eastern Time (US & Canada)" }));
    expect(onPatch).toHaveBeenCalledWith({ evaluationTimeZone: "Eastern Standard Time" });
  });

  it("clears the time zone back to UTC", async () => {
    const { onPatch } = mount({ evaluationTimeZone: "Eastern Standard Time" });
    open("Evaluation");
    fireEvent.click(screen.getByRole("combobox", { name: /Rule time zone/ }));
    fireEvent.click(await screen.findByRole("option", { name: "UTC (default)" }));
    expect(onPatch).toHaveBeenCalledWith({ evaluationTimeZone: null });
  });

  it("explains the time zone behind an info icon", () => {
    mount();
    open("Evaluation");
    expect(screen.getByRole("button", { name: "More info: Rule time zone" })).toBeInTheDocument();
  });

  it("keeps an id outside the list visible", () => {
    mount({ evaluationTimeZone: "Samoa Standard Time" });
    open("Evaluation");
    expect(screen.getByRole("combobox", { name: /Rule time zone/ })).toHaveTextContent("Samoa Standard Time");
  });
});
