import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { fakeMetadata, tableMeta, renderWithMeta } from "./metaFixtures";
import { TablePicker } from "../../src/editor/ui/pickers/MetadataPickers";

function metaWithTables() {
  const svc = fakeMetadata({});
  svc.tables = async () => [
    tableMeta({ logicalName: "account", displayName: "Account", isCustom: false }),
    tableMeta({ logicalName: "asx_rule", displayName: "Rule", isCustom: true }),
  ];
  return svc;
}

describe("TablePicker", () => {
  it("renders a searchable combobox and filters by typed text", async () => {
    renderWithMeta(<TablePicker value={null} onChange={() => {}} />, metaWithTables());
    const combo = await screen.findByRole("combobox");
    fireEvent.click(combo);
    fireEvent.input(combo, { target: { value: "rule" } });
    expect(await screen.findByText(/Rule \(asx_rule\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Account \(account\)/)).toBeNull();
  });

  it("custom-only checkbox hides system tables", async () => {
    renderWithMeta(<TablePicker value={null} onChange={() => {}} />, metaWithTables());
    const combo = await screen.findByRole("combobox");
    fireEvent.click(combo);
    fireEvent.click(await screen.findByLabelText("Custom tables only"));
    expect(screen.queryByText(/Account \(account\)/)).toBeNull();
    expect(await screen.findByText(/Rule \(asx_rule\)/)).toBeInTheDocument();
  });

  it("calls onChange with the logical name on select", async () => {
    const onChange = vi.fn();
    renderWithMeta(<TablePicker value={null} onChange={onChange} />, metaWithTables());
    const combo = await screen.findByRole("combobox");
    fireEvent.click(combo);
    fireEvent.click(await screen.findByText(/Account \(account\)/));
    expect(onChange).toHaveBeenCalledWith("account");
  });
});
