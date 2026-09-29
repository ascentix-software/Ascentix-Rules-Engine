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

describe("RuleInspector — On demand", () => {
  it("shows Runs for only when On demand is ticked", () => {
    mount({ triggers: [4] });
    expect(screen.queryByRole("combobox", { name: "Runs for" })).not.toBeInTheDocument();

    mount({ triggers: [3, 4] });
    expect(screen.getByRole("combobox", { name: "Runs for" })).toBeInTheDocument();
  });

  it("patches the scope", async () => {
    const { onPatch } = mount({ triggers: [3] });
    fireEvent.click(screen.getByRole("combobox", { name: "Runs for" }));
    fireEvent.click(await screen.findByText("All records that pass its execution conditions"));
    expect(onPatch).toHaveBeenCalledWith({ onDemandScope: 2 });
  });

  it("labels trigger 3 On demand", () => {
    mount();
    fireEvent.click(screen.getByRole("combobox", { name: "Triggers (at least one)" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "On demand" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Manual" })).not.toBeInTheDocument();
  });
});
