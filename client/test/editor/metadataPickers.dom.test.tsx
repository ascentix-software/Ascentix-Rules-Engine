import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { ColumnPicker, ValueEditor } from "../../src/editor/ui/pickers/MetadataPickers";

const ACCOUNT = [col({ logicalName: "name", displayName: "Account name" })];

describe("ColumnPicker custom-columns filter placement", () => {
  it("passes through an aria-label", async () => {
    renderWithMeta(
      <ColumnPicker table="account" context="read" value={null} onChange={() => {}} ariaLabel="Column 1" />,
      fakeMetadata({ account: ACCOUNT }),
    );
    expect(await screen.findByRole("combobox", { name: "Column 1" })).toBeInTheDocument();
  });

  it("does not show the filter until the popover is open", async () => {
    renderWithMeta(
      <ColumnPicker table="account" context="read" value={null} onChange={() => {}} ariaLabel="Column 1" />,
      fakeMetadata({ account: ACCOUNT }),
    );
    const combo = await screen.findByRole("combobox", { name: "Column 1" });
    expect(screen.queryByLabelText("Custom columns only")).toBeNull();
    fireEvent.click(combo);
    expect(await screen.findByLabelText("Custom columns only")).toBeInTheDocument();
  });
});

describe("ColumnPicker in a condition sentence", () => {
  // The column's type shows beside its name and hides while the list is open. Hiding it once
  // remounted the Combobox mid-click: focus fell to the page and the list never opened.
  it("opens on the first click with a column already chosen, keeping the same focused input", async () => {
    renderWithMeta(
      <ColumnPicker sentence table="account" context="read" value="name" onChange={() => {}} ariaLabel="Column" />,
      fakeMetadata({ account: ACCOUNT }),
    );
    const combo = await screen.findByRole("combobox", { name: "Column" });
    expect(combo).toHaveValue("Account name");
    combo.focus();
    fireEvent.click(combo);
    expect(await screen.findByRole("option", { name: "Account name · name" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Column" })).toBe(combo);
    expect(combo).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(combo);
  });
});

describe("ValueEditor accessible name", () => {
  it("forwards aria-label to a boolean value control", async () => {
    renderWithMeta(
      <ValueEditor table="opportunity" column="asx_needsreview" value={null} onChange={() => {}}
        ariaLabel="Value for Needs review" />,
      fakeMetadata({ opportunity: [col({ logicalName: "asx_needsreview", displayName: "Needs review", attributeType: "Boolean" })] }),
    );
    expect(await screen.findByRole("combobox", { name: "Value for Needs review" })).toBeInTheDocument();
  });
});
