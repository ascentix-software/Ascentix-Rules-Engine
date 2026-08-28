import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { fakeMetadata } from "./metaFixtures";
import { RecordPickerDialog } from "../../src/editor/ui/pickers/RecordPickerDialog";
import type { SavedView } from "../../src/editor/load/views";
import type { RecordRow } from "../../src/editor/records";

function view(o: Partial<SavedView> & { id: string }): SavedView {
  return { name: o.name ?? "Active", isPersonal: false, isDefault: true,
    fetchXml: `<fetch><entity name="account"><attribute name="name" /></entity></fetch>`,
    columns: [{ logicalName: "name", displayName: "Name", width: 200 }], ...o };
}

function harness(rows: RecordRow[], onSelect = vi.fn()) {
  return harnessWith(vi.fn(async () => rows), onSelect);
}

function harnessWith(
  queryByFetchXml: (table: string, fetchXml: string) => Promise<RecordRow[]>,
  onSelect = vi.fn(),
  views?: SavedView[],
) {
  const meta = fakeMetadata({ account: [] });
  meta.views = async () => views ?? [view({ id: "v1" })];
  const records: any = { queryByFetchXml, search: vi.fn(), resolveName: vi.fn() };
  render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <RecordPickerDialog open table="account" onSelect={onSelect} onCancel={() => {}} />
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
  return { records, onSelect };
}

function page(n: number, size = 50): RecordRow[] {
  return Array.from({ length: size }, (_, i) => {
    const k = n * 1000 + i;
    return { id: `g${k}`, name: `Rec ${k}`, entity: { accountid: `g${k}`, name: `Rec ${k}` } };
  });
}

describe("RecordPickerDialog", () => {
  it("loads the default view and lists records", async () => {
    harness([{ id: "g1", name: "Acme", entity: { accountid: "g1", name: "Acme" } }]);
    expect(await screen.findByText("Acme")).toBeInTheDocument();
  });

  it("returns the chosen record via onSelect", async () => {
    const { onSelect } = harness([{ id: "g1", name: "Acme", entity: { accountid: "g1", name: "Acme" } }]);
    fireEvent.click(await screen.findByText("Acme"));
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    expect(onSelect).toHaveBeenCalledWith("g1", "Acme");
  });

  it("shows an empty state when no records match", async () => {
    harness([]);
    expect(await screen.findByText(/no records match/i)).toBeInTheDocument();
  });

  it("Retry after a failed Load more re-runs the failed page (page 2), not page 1", async () => {
    const first = page(1); // 50 rows → hasMore true → "Load more" appears
    const second = page(2);
    // page 1 succeeds, the page-2 "Load more" rejects once, then subsequent calls succeed.
    const query = vi.fn<(table: string, fetchXml: string) => Promise<RecordRow[]>>()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(second);
    harnessWith(query);

    // First page loaded.
    await screen.findByText("Rec 1000");
    const loadMore = await screen.findByRole("button", { name: /load more/i });

    // Load more (page 2) fails → error banner + Retry, existing 50 rows preserved.
    fireEvent.click(loadMore);
    await screen.findByRole("button", { name: /retry/i });
    expect(screen.getByText("Rec 1000")).toBeInTheDocument(); // rows not wiped

    // The failed call requested page 2.
    const failedCall = query.mock.calls[1];
    expect(failedCall[1]).toContain('page="2"');

    // Retry re-runs page 2 (append), not page 1.
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await screen.findByText("Rec 2000");
    const retryCall = query.mock.calls[query.mock.calls.length - 1];
    expect(retryCall[1]).toContain('page="2"');
    expect(screen.getByText("Rec 1000")).toBeInTheDocument(); // original page still present
  });

  // FIX A: a requery that repopulates the grid must clear a stale selection.
  it("clears the selection when a requery repopulates the grid", async () => {
    const first = [{ id: "g1", name: "Acme", entity: { accountid: "g1", name: "Acme" } }];
    const second = [{ id: "g2", name: "Globex", entity: { accountid: "g2", name: "Globex" } }];
    const query = vi.fn<(table: string, fetchXml: string) => Promise<RecordRow[]>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    harnessWith(query);

    // Select a row → Select becomes enabled.
    fireEvent.click(await screen.findByText("Acme"));
    expect(screen.getByRole("button", { name: /^select$/i })).toBeEnabled();

    // Change the search → debounced requery to a different result set.
    fireEvent.change(screen.getByRole("textbox", { name: /search records/i }), { target: { value: "glob" } });
    await screen.findByText("Globex");

    // Selection cleared → Select disabled again (can't fire onSelect for a now-hidden record).
    await waitFor(() => expect(screen.getByRole("button", { name: /^select$/i })).toBeDisabled());
  });

  // FIX B: a late in-flight append must not land after a newer page-1 query.
  it("drops a stale in-flight append when a newer query supersedes it", async () => {
    const deferreds: Array<(r: RecordRow[]) => void> = [];
    const query = vi.fn((_t: string, _f: string) =>
      new Promise<RecordRow[]>((resolve) => { deferreds.push(resolve); }));
    harnessWith(query as any);

    // Resolve the initial page-1 query with a full page → "Load more" appears.
    await waitFor(() => expect(deferreds.length).toBe(1));
    deferreds[0](page(1));
    await screen.findByText("Rec 1000");
    const loadMore = await screen.findByRole("button", { name: /load more/i });

    // Query A: Load more (append, page 2), left pending.
    fireEvent.click(loadMore);
    await waitFor(() => expect(deferreds.length).toBe(2));

    // Query B (supersedes A): search change → page-1 replace.
    fireEvent.change(screen.getByRole("textbox", { name: /search records/i }), { target: { value: "z" } });
    await waitFor(() => expect(deferreds.length).toBe(3));

    // Resolve B first, then A (late). A must be dropped, not appended.
    deferreds[2](page(3));
    await screen.findByText("Rec 3000");
    deferreds[1](page(2));

    await waitFor(() => expect(screen.queryByText("Rec 2000")).toBeNull());
    expect(screen.getByText("Rec 3000")).toBeInTheDocument();
  });

  // FIX C: lookup/owner columns come back as _<logical>_value with the label on its
  // FormattedValue annotation; the grid must render the label, not blank.
  it("renders lookup column values from the _<logical>_value formatted annotation", async () => {
    const rows: RecordRow[] = [{
      id: "g1", name: "Acme",
      entity: {
        accountid: "g1", name: "Acme",
        _primarycontactid_value: "c1",
        "_primarycontactid_value@OData.Community.Display.V1.FormattedValue": "Jane Doe",
      },
    }];
    harnessWith(vi.fn(async () => rows), vi.fn(),
      [view({ id: "v1", columns: [{ logicalName: "primarycontactid", displayName: "Primary Contact", width: 150 }] })]);
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
  });
});
