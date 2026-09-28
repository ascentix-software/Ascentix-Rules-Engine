import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { fakeMetadata } from "./metaFixtures";
import { MultiRecordPickerDialog } from "../../src/editor/ui/pickers/MultiRecordPickerDialog";
import type { SavedView } from "../../src/editor/load/views";
import type { RecordRow } from "../../src/editor/records";

function view(o: Partial<SavedView> & { id: string }): SavedView {
  return { name: o.name ?? "Active", isPersonal: false, isDefault: true,
    fetchXml: `<fetch><entity name="account"><attribute name="name" /></entity></fetch>`,
    columns: [{ logicalName: "name", displayName: "Name", width: 200 }], ...o };
}

function harness(rows: RecordRow[], max: number, onSelect = vi.fn(), onCancel = vi.fn()) {
  const meta = fakeMetadata({ account: [] });
  meta.views = async () => [view({ id: "v1" })];
  const records: any = { queryByFetchXml: vi.fn(async () => rows), search: vi.fn(), resolveName: vi.fn() };
  render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <MultiRecordPickerDialog open table="account" max={max} onSelect={onSelect} onCancel={onCancel} />
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
  return { onSelect, onCancel };
}

function rows(n: number): RecordRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `g${i}`, name: `Rec ${i}`, entity: { accountid: `g${i}`, name: `Rec ${i}` },
  }));
}

describe("MultiRecordPickerDialog", () => {
  it("checking two rows and pressing Select 2 records calls onSelect with both ids", async () => {
    const { onSelect } = harness(rows(3), 10);
    await screen.findByText("Rec 0");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rec 0" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rec 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Select 2 records" }));
    expect(onSelect).toHaveBeenCalledWith(["g0", "g1"]);
  });

  it("disables a third checkbox and shows the cap message when max is reached", async () => {
    harness(rows(3), 2);
    await screen.findByText("Rec 0");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rec 0" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rec 1" }));
    expect(screen.getByRole("checkbox", { name: "Select Rec 2" })).toBeDisabled();
    expect(screen.getByText("You can choose up to 2 records.")).toBeInTheDocument();
  });

  it("Cancel calls onCancel", async () => {
    const { onCancel } = harness(rows(1), 5);
    await screen.findByText("Rec 0");
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("keeps the selection across a new search, even once the checked row scrolls out of view", async () => {
    const first = rows(1); // g0 "Rec 0"
    const second: RecordRow[] = [{ id: "g9", name: "Rec 9", entity: { accountid: "g9", name: "Rec 9" } }];
    const query = vi.fn<(table: string, fetchXml: string) => Promise<RecordRow[]>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    const onSelect = vi.fn();
    const meta = fakeMetadata({ account: [] });
    meta.views = async () => [view({ id: "v1" })];
    const records: any = { queryByFetchXml: query, search: vi.fn(), resolveName: vi.fn() };
    render(
      <AppProvider>
        <MetadataProvider service={meta}>
          <RecordSearchProvider service={records}>
            <MultiRecordPickerDialog open table="account" max={5} onSelect={onSelect} onCancel={vi.fn()} />
          </RecordSearchProvider>
        </MetadataProvider>
      </AppProvider>,
    );

    await screen.findByText("Rec 0");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rec 0" }));
    expect(screen.getByRole("button", { name: "Select 1 record" })).toBeEnabled();

    // Debounced requery to a different result set that no longer contains the checked row.
    fireEvent.change(screen.getByRole("textbox", { name: /search records/i }), { target: { value: "z" } });
    await screen.findByText("Rec 9");
    expect(screen.queryByText("Rec 0")).toBeNull();

    // The selection (count, button label) survives even though the row isn't rendered any more.
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select 1 record" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Select 1 record" }));
    expect(onSelect).toHaveBeenCalledWith(["g0"]);
  });
});
