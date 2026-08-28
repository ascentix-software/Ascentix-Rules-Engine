import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, within, waitFor } from "@testing-library/react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { withNarrowViewport } from "./domFixtures";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import type { RecordSearchService } from "../../src/editor/records";
import { FieldMappingDialog } from "../../src/editor/ui/inspectors/FieldMappingDialog";

// LookupPicker (rendered by ValueEditor for lookup-family columns, e.g. the literal-source
// default when a row's target is first set to a lookup column) requires RecordSearchProvider;
// this fake keeps FieldMappingDialog's own tests independent of record-search behavior.
const fakeRecords: RecordSearchService = {
  search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [],
};

const OPP = [
  col({ logicalName: "asx_needsreview", displayName: "Needs review", attributeType: "Boolean" }),
  col({ logicalName: "asx_reviewby", displayName: "Review by", attributeType: "DateTime" }),
  col({ logicalName: "asx_summary", displayName: "Summary", attributeType: "String" }),
];
const COLS = { opportunity: OPP, account: [col({ logicalName: "name", displayName: "Account name" })] };

// Two-row fixture reused by the master-detail list/detail tests below.
const TWO_ROW_MAPPING = JSON.stringify([
  { target: "asx_needsreview", source: "literal", value: true },
  { target: "asx_reviewby", source: "dateexpr", anchor: { kind: "now" }, op: "add", amount: 3, unit: "days" },
]);
const SECOND_ROW_TARGET_LABEL = "Review by";

function renderDialog(
  over: Partial<React.ComponentProps<typeof FieldMappingDialog>> = {},
  svc = fakeMetadata(COLS),
) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  const utils = renderWithMeta(
    <RecordSearchProvider service={fakeRecords}>
      <FieldMappingDialog open title="Update record" targetTable="opportunity" ruleTable="account"
        tableConfigs={{}} fieldMapping={null} onCancel={onCancel} onApply={onApply} {...over} />
    </RecordSearchProvider>,
    svc,
  );
  return { ...utils, onApply, onCancel };
}

describe("FieldMappingDialog states", () => {
  it("shows the loading state with a live region and disabled Apply while columns load", () => {
    renderDialog({}, fakeMetadata(COLS, { pending: true }));
    expect(screen.getByText(/Loading columns for opportunity/i)).toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("shows the empty state with Apply enabled and adds a row", async () => {
    renderDialog();
    expect(await screen.findByText("No columns mapped yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Add column/ }));
    expect(await screen.findByRole("combobox", { name: "Column 1" })).toBeInTheDocument();
    expect(screen.queryByText("No columns mapped yet")).toBeNull();
  });

  it("applying the empty mapping clears it to null", async () => {
    const { onApply } = renderDialog();
    await screen.findByText("No columns mapped yet");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(null);
  });

  it("renders a list item per row, and selecting one shows an accessible editor for it", async () => {
    renderDialog({ fieldMapping: TWO_ROW_MAPPING });
    const items = await screen.findAllByTestId("fm-list-item");
    expect(items).toHaveLength(2);

    fireEvent.click(items[0]);
    expect(screen.getByRole("combobox", { name: /Source for Needs review/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove Needs review mapping/ })).toBeInTheDocument();

    fireEvent.click(items[1]);
    expect(screen.getByRole("combobox", { name: /Source for Review by/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove Review by mapping/ })).toBeInTheDocument();
  });

  it("opens the raw editor when the saved mapping cannot be parsed, and announces it as an alert", async () => {
    renderDialog({ fieldMapping: "{ not json" });
    expect(await screen.findByText(/We couldn't read the saved mapping/)).toBeInTheDocument();
    expect(screen.getByLabelText("Raw JSON mapping")).toHaveValue("{ not json");
    // The raw parse-error banner is a Callout(intent="warning"), which supplies role="alert",
    // so unreadable saved JSON is announced to assistive technology rather than shown silently.
    expect(screen.getByRole("alert")).toHaveTextContent(/We couldn't read the saved mapping/);
  });

  it("toggles to JSON mode seeded from the current rows", async () => {
    const mapping = JSON.stringify([{ target: "asx_needsreview", source: "literal", value: true }]);
    renderDialog({ fieldMapping: mapping });
    fireEvent.click(await screen.findByRole("button", { name: /Edit as JSON/ }));
    expect(screen.getByLabelText("Raw JSON mapping")).toHaveValue(mapping);
  });

  it("renders a list item per row and selecting one swaps the detail", async () => {
    renderDialog({ fieldMapping: TWO_ROW_MAPPING });
    const items = await screen.findAllByTestId("fm-list-item");
    expect(items).toHaveLength(2);
    fireEvent.click(items[1]);
    const detail = screen.getByTestId("fm-detail");
    expect(within(detail).getByText(SECOND_ROW_TARGET_LABEL)).toBeInTheDocument();
  });

  it("narrow: the rail stacks above the detail", async () => {
    await withNarrowViewport(async () => {
      renderDialog({ fieldMapping: TWO_ROW_MAPPING });
      await screen.findAllByTestId("fm-list-item");
      expect(screen.getByTestId("fm-body").style.flexDirection).toBe("column");
    });
  });
});

describe("FieldMappingDialog validation", () => {
  it("blocks Apply, shows a role=alert summary, and clears live when a row is removed", async () => {
    const { onApply } = renderDialog();
    await screen.findByText("No columns mapped yet");
    fireEvent.click(screen.getByRole("button", { name: /Add column/ }));
    await screen.findByRole("combobox", { name: "Column 1" });
    fireEvent.click(screen.getByRole("button", { name: /Add column/ }));
    await screen.findByRole("combobox", { name: "Column 2" });

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).not.toHaveBeenCalled();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Remove .* mapping/ }));
    await waitFor(() =>
      expect(within(screen.getByRole("alert")).getAllByRole("listitem")).toHaveLength(1));
  });

  it("flags a date-calculation row inline and in the summary when they must agree", async () => {
    const mapping = JSON.stringify([{
      target: "asx_reviewby", source: "dateexpr",
      anchor: { kind: "field", node: null, column: null }, op: "add", amount: 1, unit: "days",
    }]);
    const { onApply } = renderDialog({ fieldMapping: mapping });
    fireEvent.click(await screen.findByTestId("fm-list-item"));
    await screen.findByRole("combobox", { name: /Source for Review by/ });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).not.toHaveBeenCalled();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getAllByRole("listitem").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Choose the anchor date column.")).toBeInTheDocument();
  });

  it("does not flag an editable row as duplicate of an unknown-source row on the same target", async () => {
    const mapping = JSON.stringify([
      { target: "asx_needsreview", source: "mystery", keep: "verbatim" },
      { target: "asx_needsreview", source: "literal", value: true },
    ]);
    const { onApply } = renderDialog({ fieldMapping: mapping });
    expect(await screen.findAllByTestId("fm-list-item")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalled();
    expect(screen.queryByText("Already mapped in another row.")).toBeNull();
  });

  it("moves focus to the remaining row's column picker after a removal", async () => {
    const mapping = JSON.stringify([
      { target: "asx_needsreview", source: "literal", value: true },
      { target: "asx_summary", source: "literal", value: "x" },
    ]);
    renderDialog({ fieldMapping: mapping });
    const items = await screen.findAllByTestId("fm-list-item");
    fireEvent.click(items[0]);
    const removeFirst = await screen.findByRole("button", { name: /Remove .* mapping/ });
    fireEvent.click(removeFirst);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Column 1" })).toHaveFocus());
  });

  it("moves focus to the Add-column button after removing the last row", async () => {
    const mapping = JSON.stringify([{ target: "asx_needsreview", source: "literal", value: true }]);
    renderDialog({ fieldMapping: mapping });
    fireEvent.click(await screen.findByTestId("fm-list-item"));
    const remove = await screen.findByRole("button", { name: /Remove .* mapping/ });
    fireEvent.click(remove);
    await waitFor(() => expect(screen.getByRole("button", { name: /Add column/ })).toHaveFocus());
  });
});

describe("FieldMappingDialog ref source", () => {
  const OPP_REF = [
    col({ logicalName: "asx_owner", displayName: "Owner", attributeType: "Lookup" }),
  ];
  const COLS_REF = { opportunity: OPP_REF, account: [col({ logicalName: "name", displayName: "Account name" })] };
  const ROOT_ID = "a1b2c3d4-0000-0000-0000-0000000000aa";
  const rootConfigs = {
    [ROOT_ID]: {
      id: ROOT_ID, name: "Account", tableLogicalName: "account",
      tableConfigType: "RootTable" as const, parentTableConfigId: null,
      lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
    },
  };

  it("renders a ref row's Record dropdown with the root labeled 'this record'", async () => {
    const mapping = JSON.stringify([{ target: "asx_owner", source: "ref", node: ROOT_ID }]);
    renderDialog({ fieldMapping: mapping, targetTable: "opportunity", tableConfigs: rootConfigs },
      fakeMetadata(COLS_REF));
    fireEvent.click(await screen.findByTestId("fm-list-item"));
    expect(await screen.findByRole("combobox", { name: /Record for Owner/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Record for Owner/ }))
      .toHaveTextContent(/Account/);
  });

  it("offers 'Link to a record' as a source only for a lookup column", async () => {
    renderDialog({ targetTable: "opportunity", tableConfigs: rootConfigs }, fakeMetadata(COLS_REF));
    fireEvent.click(await screen.findByRole("button", { name: /Add column/ }));
    // Pick the lookup column so the Source options recompute. ColumnPicker's options render
    // as "<displayName> (<logicalName>)", so match on the display name via regex.
    const colBox = await screen.findByRole("combobox", { name: "Column 1" });
    fireEvent.click(colBox);
    fireEvent.click(await screen.findByRole("option", { name: /^Owner/ }));
    fireEvent.click(screen.getByRole("combobox", { name: /Source for/ }));
    expect(await screen.findByRole("option", { name: "Link to a record" })).toBeInTheDocument();
  });

  it("does not offer 'Link to a record' as a source for a non-lookup column", async () => {
    renderDialog({ targetTable: "opportunity", tableConfigs: rootConfigs }, fakeMetadata(COLS));
    fireEvent.click(await screen.findByRole("button", { name: /Add column/ }));
    // Pick a non-lookup column (Boolean). ColumnPicker's options render as
    // "<displayName> (<logicalName>)", so match on the display name via regex.
    const colBox = await screen.findByRole("combobox", { name: "Column 1" });
    fireEvent.click(colBox);
    fireEvent.click(await screen.findByRole("option", { name: /^Needs review/ }));
    fireEvent.click(screen.getByRole("combobox", { name: /Source for/ }));
    expect(screen.queryByRole("option", { name: "Link to a record" })).toBeNull();
  });
});

describe("FieldMappingDialog mathexpr source", () => {
  const OPP_NUM = [
    col({ logicalName: "amount", displayName: "Amount", attributeType: "Money" }),
  ];
  const COLS_NUM = { opportunity: OPP_NUM, account: [col({ logicalName: "name", displayName: "Account name" })] };

  it("offers 'Calculation' as a source for a numeric column and renders the calculation editor", async () => {
    renderDialog({ targetTable: "opportunity" }, fakeMetadata(COLS_NUM));
    fireEvent.click(await screen.findByRole("button", { name: /Add column/ }));
    // Pick the numeric column so the Source options recompute. ColumnPicker's options render
    // as "<displayName> (<logicalName>)", so match on the display name via regex.
    const colBox = await screen.findByRole("combobox", { name: "Column 1" });
    fireEvent.click(colBox);
    fireEvent.click(await screen.findByRole("option", { name: /^Amount/ }));
    fireEvent.click(screen.getByRole("combobox", { name: /Source for/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Calculation" }));
    // Choosing Calculation switches the value editor to MathExprEditor's textarea + Insert field menu.
    expect(screen.getByPlaceholderText(/use Insert field/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Insert field" })).toBeInTheDocument();
  });

  it("does not offer 'Calculation' as a source for a non-numeric column", async () => {
    renderDialog({ targetTable: "opportunity" }, fakeMetadata(COLS));
    fireEvent.click(await screen.findByRole("button", { name: /Add column/ }));
    const colBox = await screen.findByRole("combobox", { name: "Column 1" });
    fireEvent.click(colBox);
    fireEvent.click(await screen.findByRole("option", { name: /^Needs review/ }));
    fireEvent.click(screen.getByRole("combobox", { name: /Source for/ }));
    expect(screen.queryByRole("option", { name: "Calculation" })).toBeNull();
  });
});

describe("FieldMappingDialog mathexpr aggregate source", () => {
  const OPP_NUM = [
    col({ logicalName: "amount", displayName: "Amount", attributeType: "Money" }),
  ];
  const LINEITEM_NUM = [
    col({ logicalName: "amount", displayName: "Line amount", attributeType: "Money" }),
  ];
  const COLS_AGG = {
    opportunity: OPP_NUM,
    account: [col({ logicalName: "name", displayName: "Account name" })],
    lineitem: LINEITEM_NUM,
  };
  const ROOT_ID = "b1b2c3d4-0000-0000-0000-0000000000bb";
  const CHILD_ID = "c1b2c3d4-0000-0000-0000-0000000000cc";
  const tableConfigsWithCollection = {
    [ROOT_ID]: {
      id: ROOT_ID, name: "Account", tableLogicalName: "account",
      tableConfigType: "RootTable" as const, parentTableConfigId: null,
      lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
    },
    [CHILD_ID]: {
      id: CHILD_ID, name: "Line items", tableLogicalName: "lineitem",
      tableConfigType: "ChildTable" as const, parentTableConfigId: ROOT_ID,
      lookupColumnLogicalName: null, childLinkField: "parentid", lookupTargetIdAttribute: null,
    },
  };

  async function openCalculationEditor(tableConfigs: React.ComponentProps<typeof FieldMappingDialog>["tableConfigs"]) {
    renderDialog({ targetTable: "opportunity", tableConfigs }, fakeMetadata(COLS_AGG));
    fireEvent.click(await screen.findByRole("button", { name: /Add column/ }));
    const colBox = await screen.findByRole("combobox", { name: "Column 1" });
    fireEvent.click(colBox);
    fireEvent.click(await screen.findByRole("option", { name: /^Amount/ }));
    fireEvent.click(screen.getByRole("combobox", { name: /Source for/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Calculation" }));
  }

  it("shows an Insert aggregate control for a numeric target when a child collection exists", async () => {
    await openCalculationEditor(tableConfigsWithCollection);
    expect(screen.getByRole("button", { name: "Insert aggregate" })).toBeInTheDocument();
  });

  it("does not show an Insert aggregate control when there is no child collection", async () => {
    await openCalculationEditor({});
    expect(screen.queryByRole("button", { name: "Insert aggregate" })).toBeNull();
  });

  // The detail pane must remount per selected row. MathExprEditor keeps
  // its own "last successfully parsed aggregates" ref (lastGoodAggRefsRef, the inert-rows
  // rule) so a mid-edit parse failure doesn't wipe its chip section. Without a per-row key on
  // <DetailPane>, that same editor *instance* survives a rail row-switch, so switching to a
  // freshly-selected row whose own expression hasn't parsed yet (e.g. Calculation chosen but
  // nothing typed) would leave the *previous* row's stale aggregate chip on screen. Row 2 here is
  // deliberately unparseable (empty expression): that's the only way to observe the ref
  // surviving vs. resetting; a row with its own valid aggregate would repaint correctly on
  // props alone, key or no key, and wouldn't distinguish the two behaviors.
  it("never shows a previous row's aggregate chip after switching to a row with no parsed aggregate of its own", async () => {
    const mapping = JSON.stringify([
      { target: "amount", source: "mathexpr", expression: `sum(node:${CHILD_ID}.amount)` },
      { target: "amount2", source: "mathexpr", expression: "" },
    ]);
    const OPP_TWO_NUM = [
      ...OPP_NUM,
      col({ logicalName: "amount2", displayName: "Amount 2", attributeType: "Money" }),
    ];
    renderDialog(
      { fieldMapping: mapping, targetTable: "opportunity", tableConfigs: tableConfigsWithCollection },
      fakeMetadata({ ...COLS_AGG, opportunity: OPP_TWO_NUM }),
    );
    const items = await screen.findAllByTestId("fm-list-item");
    expect(items).toHaveLength(2);
    const detail = screen.getByTestId("fm-detail");

    fireEvent.click(items[0]);
    expect(await within(detail).findByTestId("agg-section")).toHaveTextContent("Line items");

    fireEvent.click(items[1]);
    // Row 2's expression is empty, so it has no aggregate of its own yet: the chip section
    // must be gone entirely, never showing row 1's "Line items" collection.
    expect(within(detail).queryByTestId("agg-section")).toBeNull();
  });
});
