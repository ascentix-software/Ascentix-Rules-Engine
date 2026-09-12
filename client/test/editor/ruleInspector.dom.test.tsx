import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithMeta, fakeMetadata } from "./metaFixtures";
import { makeGraph } from "./domFixtures";
import { RuleInspector } from "../../src/editor/ui/inspectors/RuleInspector";
import type { RuleHeader } from "../../src/editor/model/types";

function mount(ruleOver: Partial<RuleHeader> = {}, onPatch = vi.fn()) {
  const rule: RuleHeader = { ...makeGraph().rule, ...ruleOver };
  renderWithMeta(<RuleInspector rule={rule} onPatch={onPatch} />, fakeMetadata({ account: [] }));
  return { rule, onPatch };
}

describe("RuleInspector", () => {
  it("shows the rule's table in the disabled Table field", () => {
    mount();
    const tableInput = screen.getByDisplayValue("account");
    expect(tableInput).toBeInTheDocument();
    expect(tableInput).toBeDisabled();
  });

  it("renders the Triggers combobox", () => {
    mount();
    expect(screen.getByRole("combobox", { name: "Triggers (at least one)" })).toBeInTheDocument();
  });

  it("shows the Effective-from date when the rule has one", () => {
    mount({ effectiveFrom: "2026-01-01" });
    expect(screen.getByLabelText("Effective from")).toHaveValue("2026-01-01T00:00");
  });

  it("fires onPatch with the new Effective-from date on change", () => {
    const { onPatch } = mount({ effectiveFrom: "2026-01-01" });
    fireEvent.change(screen.getByLabelText("Effective from"), { target: { value: "2026-02-02T17:30" } });
    expect(onPatch).toHaveBeenCalledWith({ effectiveFrom: "2026-02-02T17:30:00.000Z" });
  });

  it("defaults the Evaluation context combobox to User", async () => {
    mount();
    expect(await screen.findByRole("combobox", { name: "Evaluation context" })).toHaveTextContent("User");
  });
});
