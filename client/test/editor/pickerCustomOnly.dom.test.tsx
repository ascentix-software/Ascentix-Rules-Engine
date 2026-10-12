import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { fakeMetadata, col, tableMeta, renderWithMeta } from "./metaFixtures";
import { ColumnPicker, TablePicker } from "../../src/editor/ui/pickers/MetadataPickers";

// The listbox treated a click on the popup's "Custom … only" checkbox as an option pick and
// cancelled it, so the checkbox wouldn't toggle (or, in a browser, wouldn't untick).
describe("picker popups", () => {
  it("Custom columns only ticks and unticks, filtering the list each way", async () => {
    const svc = fakeMetadata({ account: [
      col({ logicalName: "name", displayName: "Name", isCustom: false }),
      col({ logicalName: "new_x", displayName: "X", isCustom: true }),
    ] });
    renderWithMeta(<ColumnPicker table="account" context="read" value={null} onChange={() => {}} ariaLabel="Column" />, svc);
    fireEvent.click(await screen.findByRole("combobox", { name: "Column" }));
    const box = () => screen.getByRole("checkbox", { name: "Custom columns only" }) as HTMLInputElement;
    await screen.findByRole("checkbox", { name: "Custom columns only" });
    expect(screen.getAllByRole("option")).toHaveLength(2);

    fireEvent.click(box());
    expect(box().checked).toBe(true);
    expect(screen.getAllByRole("option")).toHaveLength(1);

    fireEvent.click(box());
    expect(box().checked).toBe(false);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("Custom tables only ticks and unticks", async () => {
    const svc = fakeMetadata({});
    svc.tables = async () => [
      tableMeta({ logicalName: "account", displayName: "Account", isCustom: false }),
      tableMeta({ logicalName: "new_thing", displayName: "Thing", isCustom: true }),
    ];
    renderWithMeta(<TablePicker value={null} onChange={() => {}} ariaLabel="Table" />, svc);
    fireEvent.click(await screen.findByRole("combobox", { name: "Table" }));
    const box = () => screen.getByRole("checkbox", { name: "Custom tables only" }) as HTMLInputElement;
    fireEvent.click(await screen.findByRole("checkbox", { name: "Custom tables only" }));
    expect(box().checked).toBe(true);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
});
