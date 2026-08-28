import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { fakeMetadata } from "./metaFixtures";
import { LookupPicker } from "../../src/editor/ui/pickers/MetadataPickers";

function harness(onChange = vi.fn()) {
  const meta = fakeMetadata({});
  meta.lookupTargets = async () => ["account"];
  meta.tables = async () => [{ logicalName: "account", displayName: "Account", entitySetName: "accounts",
    primaryNameAttribute: "name", primaryIdAttribute: "accountid", isCustom: false }];
  meta.views = async () => [{ id: "v1", name: "Active", isPersonal: false, isDefault: true,
    fetchXml: `<fetch><entity name="account"><attribute name="name" /></entity></fetch>`,
    columns: [{ logicalName: "name", displayName: "Name", width: 200 }] }];
  const records: any = {
    search: vi.fn(async () => []), resolveName: vi.fn(async () => null),
    queryByFetchXml: vi.fn(async () => [{ id: "g1", name: "Acme", entity: { accountid: "g1", name: "Acme" } }]),
  };
  render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <LookupPicker table="contact" column="parentcustomerid" value={null} onChange={onChange} ariaLabel="Value" />
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
  return { onChange };
}

describe("LookupPicker Browse", () => {
  it("opens the record picker modal and returns the chosen id + table", async () => {
    const { onChange } = harness();
    fireEvent.click(await screen.findByRole("button", { name: /browse/i }));
    fireEvent.click(await screen.findByText("Acme"));
    // Fluent's Dialog leaves its portal marked aria-hidden until the modal focus
    // trap "activates" (a tabster behavior that doesn't settle in jsdom absent a
    // real browser focus/paint cycle). The Select button is still present and
    // functionally clickable, so query with { hidden: true } to bypass the
    // accessibility-tree filter rather than asserting on an artifact of the test
    // environment.
    fireEvent.click(await screen.findByRole("button", { name: /^select$/i, hidden: true }));
    expect(onChange).toHaveBeenCalledWith("g1", "account");
  });
});
