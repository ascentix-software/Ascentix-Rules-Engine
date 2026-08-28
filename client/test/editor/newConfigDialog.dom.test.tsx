import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
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
  it("renders open with title and Create disabled", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(
      <NewConfigDialog open onCancel={onCancel} onCreate={onCreate} />,
      metaWithTables(),
    );
    expect(await screen.findByText("New table configuration")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("keeps Create disabled with only a name typed", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(
      <NewConfigDialog open onCancel={onCancel} onCreate={onCreate} />,
      metaWithTables(),
    );
    const nameInput = screen.getByLabelText("Name");
    fireEvent.change(nameInput, { target: { value: "My Config" } });
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("Cancel fires onCancel, not onCreate", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(
      <NewConfigDialog open onCancel={onCancel} onCreate={onCreate} />,
      metaWithTables(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("name + selected table enables Create, which fires onCreate with trimmed name and picked table", async () => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    renderWithMeta(
      <NewConfigDialog open onCancel={onCancel} onCreate={onCreate} />,
      metaWithTables(),
    );

    const nameInput = screen.getByLabelText("Name");
    fireEvent.change(nameInput, { target: { value: "  My Config  " } });

    const combo = await screen.findByRole("combobox");
    fireEvent.click(combo);
    fireEvent.click(await screen.findByText(/Account \(account\)/));

    const createButton = screen.getByRole("button", { name: "Create" });
    expect(createButton).toBeEnabled();

    fireEvent.click(createButton);
    expect(onCreate).toHaveBeenCalledWith({ name: "My Config", table: "account" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
