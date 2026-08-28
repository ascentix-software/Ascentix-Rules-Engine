import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { col, fakeMetadata } from "./metaFixtures";
import { RecordPickerDialog } from "../../src/editor/ui/pickers/RecordPickerDialog";
import { ColumnPicker, TablePicker } from "../../src/editor/ui/pickers/MetadataPickers";

// The pickers' filter checkboxes must carry their OWN accessible name.
//
// Measured in the live editor: the record picker's "Advanced filter" checkbox had no
// aria-label, and the `<label for>` claiming its generated id read "Value" (the condition
// inspector's Field), so a screen reader announced the checkbox as "Value" (WCAG 4.1.2). Two
// distinct comboboxes were separately observed sharing id="field-r10__control".
//
// The underlying id collision is NOT fixed by these tests; an explicit aria-label makes the
// accessible name independent of whichever <label for> wins the id, which is the part that
// actually reaches a screen-reader user.

const meta = () => {
  const m = fakeMetadata({ account: [col({ logicalName: "name", displayName: "Name" })] });
  m.views = async () => [];
  return m;
};

function wrap(ui: React.ReactElement) {
  const records: any = { queryByFetchXml: vi.fn(async () => []), search: vi.fn(), resolveName: vi.fn() };
  return render(
    <AppProvider>
      <MetadataProvider service={meta()}>
        <RecordSearchProvider service={records}>{ui}</RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
}

describe("picker filter checkboxes carry their own accessible name", () => {
  it("record picker: 'Advanced filter'", async () => {
    wrap(<RecordPickerDialog open table="account" onSelect={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByRole("checkbox", { name: "Advanced filter" })).toBeInTheDocument();
  });

  it("column picker: 'Custom columns only'", async () => {
    wrap(<ColumnPicker table="account" context="read" value={null} onChange={vi.fn()} ariaLabel="Column" />);
    (await screen.findByRole("combobox", { name: "Column" })).click();
    expect(await screen.findByRole("checkbox", { name: "Custom columns only" })).toBeInTheDocument();
  });

  it("table picker: 'Custom tables only'", async () => {
    wrap(<TablePicker value={null} onChange={vi.fn()} />);
    (await screen.findByPlaceholderText("Type to filter tables")).click();
    expect(await screen.findByRole("checkbox", { name: "Custom tables only" })).toBeInTheDocument();
  });
});
