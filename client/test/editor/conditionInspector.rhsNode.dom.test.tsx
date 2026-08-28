import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, render as rtlRender } from "@testing-library/react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { ConditionInspector } from "../../src/editor/ui/inspectors/ConditionInspector";
import type { ConditionNode, TableConfigRef } from "../../src/editor/model/types";

// Measured on live DEV: the Right-hand column picker listed the columns of the CONDITION's
// own node, ignoring the Right-hand node dropdown right above it. The author picked an Order
// column believing it was a Customer column; the rule saved, validated, and misread at runtime.
// These tests pin that the RHS picker's table comes from comparisonValueNodeId.

function condition(over: Partial<ConditionNode> = {}): ConditionNode {
  return {
    id: "c1", name: "Compare", tableConfigId: "root", conditionType: "FieldComparison",
    comparisonColumn: "sample_ordertotal", comparisonOperator: 5, valueSource: 2,
    comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null, expression: null,
    ...over,
  };
}

const TABLE_CONFIGS: Record<string, TableConfigRef> = {
  root: {
    id: "root", name: "Order", tableLogicalName: "sample_order", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
  },
  cust: {
    id: "cust", name: "Customer", tableLogicalName: "sample_customer", tableConfigType: "LookupTable",
    parentTableConfigId: "root", lookupColumnLogicalName: "sample_customerid", childLinkField: null,
    lookupTargetIdAttribute: "sample_customerid",
  },
  // A SECOND node on the SAME table as `cust`: a re-point between these two must not throw away
  // a comparison column that is still valid.
  cust2: {
    id: "cust2", name: "Bill-to customer", tableLogicalName: "sample_customer", tableConfigType: "LookupTable",
    parentTableConfigId: "root", lookupColumnLogicalName: "sample_billtoid", childLinkField: null,
    lookupTargetIdAttribute: "sample_customerid",
  },
};

// Both comparison columns are Money -> kind "number", so compatibleWith cannot be what decides
// which of them the picker offers; only the resolved table can.
const META = fakeMetadata({
  sample_order: [col({ logicalName: "sample_ordertotal", displayName: "Order Total", attributeType: "Money" })],
  sample_customer: [col({ logicalName: "sample_creditlimit", displayName: "Credit Limit", attributeType: "Money" })],
});

function render(c: ConditionNode, onPatch = vi.fn()) {
  renderWithMeta(
    <ConditionInspector condition={c} ruleTable="sample_order" tableConfigs={TABLE_CONFIGS} onPatch={onPatch} />,
    META,
  );
  return onPatch;
}

async function openRhsColumnPicker() {
  const box = await screen.findByRole("combobox", { name: "Right-hand column" });
  fireEvent.click(box);
  return box;
}

describe("ConditionInspector — the Right-hand column picker resolves its table from the right-hand node", () => {
  it("offers the RIGHT-HAND node's columns when that node is on a different table", async () => {
    render(condition({ comparisonValueNodeId: "cust" }));
    await openRhsColumnPicker();

    expect(await screen.findByRole("option", { name: /sample_creditlimit/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /sample_ordertotal/ })).toBeNull();
  });

  it("falls back to the condition's own node for \"(same record)\"", async () => {
    render(condition({ comparisonValueNodeId: null }));
    await openRhsColumnPicker();

    expect(await screen.findByRole("option", { name: /sample_ordertotal/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /sample_creditlimit/ })).toBeNull();
  });

  it("re-fetches and re-lists when the right-hand node is re-pointed at another table", async () => {
    // The picker caches the previous table's columns while it re-fetches, so a live re-point (not
    // a fresh mount) is the case that has to be proven: this is what the author actually does.
    const tree = (nodeId: string | null) => (
      <AppProvider>
        <MetadataProvider service={META}>
          <ConditionInspector condition={condition({ comparisonValueNodeId: nodeId })} ruleTable="sample_order"
            tableConfigs={TABLE_CONFIGS} onPatch={vi.fn()} />
        </MetadataProvider>
      </AppProvider>
    );
    const { rerender } = rtlRender(tree(null));
    expect(await screen.findByRole("combobox", { name: "Right-hand column" })).toBeInTheDocument();

    rerender(tree("cust"));
    await openRhsColumnPicker();

    expect(await screen.findByRole("option", { name: /sample_creditlimit/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /sample_ordertotal/ })).toBeNull();
  });

  it("keeps the picker gated on the left-hand column, independent of the right-hand node", async () => {
    render(condition({ comparisonColumn: null, comparisonValueNodeId: "cust" }));
    expect(await screen.findByText(/Select a comparison column first/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Right-hand column" })).toBeNull();
  });
});

describe("ConditionInspector — stale comparison column on a right-hand node change", () => {
  it("clears comparisonValueColumn when the new node is on a different table", async () => {
    const onPatch = render(condition({ comparisonValueNodeId: null, comparisonValueColumn: "sample_ordertotal" }));
    const nodeBox = await screen.findByRole("combobox", { name: "Right-hand node" });
    fireEvent.click(nodeBox);
    fireEvent.click(await screen.findByRole("option", { name: "Customer" }));

    expect(onPatch).toHaveBeenCalledWith({ comparisonValueNodeId: "cust", comparisonValueColumn: null });
  });

  it("clears it on the way back to (same record) too", async () => {
    const onPatch = render(condition({ comparisonValueNodeId: "cust", comparisonValueColumn: "sample_creditlimit" }));
    const nodeBox = await screen.findByRole("combobox", { name: "Right-hand node" });
    fireEvent.click(nodeBox);
    fireEvent.click(await screen.findByRole("option", { name: "(same record)" }));

    expect(onPatch).toHaveBeenCalledWith({ comparisonValueNodeId: null, comparisonValueColumn: null });
  });

  it("keeps the column when the new node is a different node on the SAME table", async () => {
    const onPatch = render(condition({ comparisonValueNodeId: "cust", comparisonValueColumn: "sample_creditlimit" }));
    const nodeBox = await screen.findByRole("combobox", { name: "Right-hand node" });
    fireEvent.click(nodeBox);
    fireEvent.click(await screen.findByRole("option", { name: "Bill-to customer" }));

    expect(onPatch).toHaveBeenCalledWith({ comparisonValueNodeId: "cust2" });
  });
});
