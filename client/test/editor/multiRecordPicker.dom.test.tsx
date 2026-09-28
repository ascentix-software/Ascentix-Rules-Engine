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
});
