import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { fakeMetadata, tableMeta, renderWithMeta } from "./metaFixtures";
import { NewRuleDialog, uniqueModelName } from "../../src/editor/ui/hub/NewRuleDialog";
import type { ConfigListItem } from "../../src/editor/load/hubData";

function metaWithTables() {
  const svc = fakeMetadata({});
  svc.tables = async () => [
    tableMeta({ logicalName: "account", displayName: "Account", isCustom: false }),
    tableMeta({ logicalName: "asx_rule", displayName: "Rule", isCustom: true }),
  ];
  return svc;
}

const cfg = (over: Partial<ConfigListItem>): ConfigListItem => ({
  id: "cfg-1", name: "Account Rules", rootTableLogicalName: "account",
  nodeCount: 3, usedByCount: 2, modifiedOn: null, modifiedBy: null, ...over,
});

async function pickTable(name: RegExp) {
  const box = await screen.findByRole("combobox");
  fireEvent.click(box);
  fireEvent.click(await screen.findByRole("option", { name }));
}

describe("NewRuleDialog", () => {
  it("keeps Create enabled and explains what's missing, focusing the first invalid field", async () => {
    const onCreate = vi.fn();
    renderWithMeta(<NewRuleDialog open configs={[]} onCancel={vi.fn()} onCreate={onCreate} />, metaWithTables());
    expect(await screen.findByText("New rule")).toBeInTheDocument();
    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
    expect(screen.getByText("Choose a table.")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Name/ })).toHaveFocus();
  });

  it("groups the triggers by where they run, each checkbox with its own name", async () => {
    renderWithMeta(<NewRuleDialog open configs={[]} onCancel={vi.fn()} onCreate={vi.fn()} />, metaWithTables());
    await screen.findByText("New rule");
    for (const name of ["While editing", "Create", "Update", "Delete", "On demand"]) {
      expect(screen.getByRole("checkbox", { name })).toBeInTheDocument();
    }
    for (const group of ["On the form", "When saved", "On demand"]) {
      expect(screen.getByRole("button", { name: `More info: ${group}` })).toBeInTheDocument();
    }
  });

  it("asks for the table first; Data model appears with matching models, most-used preselected", async () => {
    const configs = [cfg({ id: "a", name: "Less used", usedByCount: 1 }), cfg({ id: "b", name: "Most used", usedByCount: 5 }),
      cfg({ id: "c", name: "Other table", rootTableLogicalName: "asx_rule" })];
    renderWithMeta(<NewRuleDialog open configs={configs} onCancel={vi.fn()} onCreate={vi.fn()} />, metaWithTables());
    await screen.findByText("New rule");
    expect(screen.queryByRole("radiogroup", { name: "Data model" })).toBeNull();
    await pickTable(/^Account · account/);
    expect(await screen.findByRole("radio", { name: /Most used/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Less used/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Other table/ })).toBeNull();
    expect(screen.getByRole("radio", { name: "Start a new model for Account" })).toBeInTheDocument();
  });

  it("creates on an existing model with the same args as before", async () => {
    const onCreate = vi.fn();
    renderWithMeta(<NewRuleDialog open configs={[cfg({})]} onCancel={vi.fn()} onCreate={onCreate} />, metaWithTables());
    await screen.findByText("New rule");
    fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), { target: { value: "  My rule " } });
    await pickTable(/^Account · account/);
    fireEvent.click(screen.getByRole("checkbox", { name: "Create" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith({ name: "My rule", table: "account", triggers: [1], existingRootId: "cfg-1", newConfigName: undefined });
  });

  it("starts a new model named after the table, made unique", async () => {
    const onCreate = vi.fn();
    renderWithMeta(<NewRuleDialog open configs={[cfg({ name: "Account", rootTableLogicalName: "asx_rule" })]}
      onCancel={vi.fn()} onCreate={onCreate} />, metaWithTables());
    await screen.findByText("New rule");
    fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), { target: { value: "R" } });
    await pickTable(/^Account · account/);
    expect(await screen.findByRole("radio", { name: "Start a new model for Account" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "On demand" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith({ name: "R", table: "account", triggers: [3], existingRootId: undefined, newConfigName: "Account (2)" });
  });
});

describe("uniqueModelName", () => {
  it("appends (2), (3)… when taken", () => {
    expect(uniqueModelName("Account", [])).toBe("Account");
    expect(uniqueModelName("Account", ["account", "Account (2)"])).toBe("Account (3)");
  });
});
