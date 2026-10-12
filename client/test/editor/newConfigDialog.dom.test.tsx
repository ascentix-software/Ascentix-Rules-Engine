import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { fakeMetadata, tableMeta, renderWithMeta } from "./metaFixtures";
import { NewConfigDialog } from "../../src/editor/ui/hub/NewConfigDialog";

function metaWithTables() {
  const svc = fakeMetadata({});
  svc.tables = async () => [
    tableMeta({ logicalName: "account", displayName: "Account", isCustom: false }),
    tableMeta({ logicalName: "asx_rule", displayName: "Rule", isCustom: true }),
  ];
  return svc;
}

describe("NewConfigDialog", () => {
  it("is titled New data model and asks for the root table first", async () => {
    renderWithMeta(<NewConfigDialog open onCancel={vi.fn()} onCreate={vi.fn()} />, metaWithTables());
    expect(await screen.findByText("New data model")).toBeInTheDocument();
    const labels = Array.from(document.querySelectorAll("label")).map((l) => l.textContent);
    expect(labels.findIndex((t) => t?.startsWith("Root table"))).toBeLessThan(labels.findIndex((t) => t?.startsWith("Name")));
  });

  it("keeps Create enabled and says what's missing", async () => {
    const onCreate = vi.fn();
    renderWithMeta(<NewConfigDialog open onCancel={vi.fn()} onCreate={onCreate} />, metaWithTables());
    await screen.findByText("New data model");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText("Choose a table.")).toBeInTheDocument();
  });

  it("Cancel fires onCancel, not onCreate", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(<NewConfigDialog open onCancel={onCancel} onCreate={onCreate} />, metaWithTables());
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("pre-fills the name from the table, keeps it editable, and creates with the trimmed name", async () => {
    const onCreate = vi.fn();
    renderWithMeta(<NewConfigDialog open onCancel={vi.fn()} onCreate={onCreate} />, metaWithTables());
    fireEvent.click(await screen.findByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: /^Account · account/ }));
    const name = screen.getByRole("textbox", { name: /^Name/ });
    await waitFor(() => expect(name).toHaveValue("Account"));
    fireEvent.change(name, { target: { value: "  My Config  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith({ name: "My Config", table: "account" });
  });
});
