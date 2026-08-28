import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { fakeMetadata, tableMeta, renderWithMeta } from "./metaFixtures";
import { NewRuleDialog } from "../../src/editor/ui/hub/NewRuleDialog";
import type { ConfigListItem } from "../../src/editor/load/hubData";

function metaWithTables() {
  const svc = fakeMetadata({});
  svc.tables = async () => [
    tableMeta({ logicalName: "account", displayName: "Account", isCustom: false }),
    tableMeta({ logicalName: "asx_rule", displayName: "Rule", isCustom: true }),
  ];
  return svc;
}

const oneConfig: ConfigListItem = {
  id: "cfg-1", name: "Account Rules", rootTableLogicalName: "account",
  nodeCount: 3, usedByCount: 2, modifiedOn: null, modifiedBy: null,
};

// Each trigger Checkbox keeps its own `label` prop as its accessible name (the Triggers group is
// labeled separately via role="group"/aria-labelledby), so checkboxes are addressable directly by
// accessible name.
function triggerCheckbox(label: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name: label }) as HTMLInputElement;
}

describe("NewRuleDialog", () => {
  it("renders open with title 'New rule' and Create disabled", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(
      <NewRuleDialog open configs={[]} onCancel={onCancel} onCreate={onCreate} />,
      metaWithTables(),
    );
    expect(await screen.findByText("New rule")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    // Each trigger checkbox must have its own distinct accessible name (WCAG 4.1.2).
    for (const name of ["On Create", "On Form", "Manual", "On Update", "On Delete"]) {
      expect(screen.getByRole("checkbox", { name })).toBeInTheDocument();
    }
  });

  it("enables Create once name, a trigger, config name, and table are all set (mode new)", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(
      <NewRuleDialog open configs={[]} onCancel={onCancel} onCreate={onCreate} />,
      metaWithTables(),
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Rule" } });
    fireEvent.click(triggerCheckbox("On Create"));
    fireEvent.change(screen.getByLabelText("Configuration name"), { target: { value: "My Config" } });

    const combo = await screen.findByRole("combobox");
    fireEvent.click(combo);
    fireEvent.click(await screen.findByText(/Account \(account\)/));

    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("Create fires onCreate with the new-mode payload", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(
      <NewRuleDialog open configs={[]} onCancel={onCancel} onCreate={onCreate} />,
      metaWithTables(),
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Rule" } });
    fireEvent.click(triggerCheckbox("On Create"));
    fireEvent.change(screen.getByLabelText("Configuration name"), { target: { value: "My Config" } });

    const combo = await screen.findByRole("combobox");
    fireEvent.click(combo);
    fireEvent.click(await screen.findByText(/Account \(account\)/));

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreate).toHaveBeenCalledWith({
      name: "My Rule", table: "account", triggers: [1],
      existingRootId: undefined, newConfigName: "My Config",
    });
  });

  it("defaults to existing mode with configs present, and lists the config in the dropdown", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(
      <NewRuleDialog open configs={[oneConfig]} onCancel={onCancel} onCreate={onCreate} />,
      metaWithTables(),
    );

    expect(screen.getByRole("radio", { name: "Use an existing configuration" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "New configuration for a table" })).not.toBeChecked();

    const combo = await screen.findByRole("combobox");
    fireEvent.click(combo);
    expect(await screen.findByText("Account Rules (account)")).toBeInTheDocument();
  });

  it("existing-mode Create fires onCreate with existingRootId/table from the chosen config", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(
      <NewRuleDialog open configs={[oneConfig]} onCancel={onCancel} onCreate={onCreate} />,
      metaWithTables(),
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Rule" } });
    fireEvent.click(triggerCheckbox("On Update"));

    const combo = await screen.findByRole("combobox");
    fireEvent.click(combo);
    fireEvent.click(await screen.findByText("Account Rules (account)"));

    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreate).toHaveBeenCalledWith({
      name: "My Rule", table: "account", triggers: [4],
      existingRootId: "cfg-1", newConfigName: undefined,
    });
  });

  it("Cancel fires onCancel, not onCreate", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(
      <NewRuleDialog open configs={[]} onCancel={onCancel} onCreate={onCreate} />,
      metaWithTables(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
