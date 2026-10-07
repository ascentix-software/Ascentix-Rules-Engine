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

describe("RuleInspector — On demand card", () => {
  it("shows the card with Runs for only when On demand is a trigger", () => {
    mount({ triggers: [4] });
    expect(screen.queryByTestId("on-demand-card")).not.toBeInTheDocument();

    mount({ triggers: [3, 4] });
    expect(screen.getByTestId("on-demand-card")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Runs for" })).toBeInTheDocument();
  });

  it("patches the scope", () => {
    const { onPatch } = mount({ triggers: [3] });
    fireEvent.click(screen.getByRole("radio", { name: "All records that match “Only if”" }));
    expect(onPatch).toHaveBeenCalledWith({ onDemandScope: 2 });
  });

  it("labels trigger 3 On demand", async () => {
    mount();
    fireEvent.click(screen.getByRole("combobox", { name: "Triggers" }));
    expect(await screen.findByRole("option", { name: "On demand" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Manual" })).not.toBeInTheDocument();
  });
});
