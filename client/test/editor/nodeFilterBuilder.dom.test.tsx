import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
// A generous async-query timeout for heavy DOM tests is configured globally in test/setup.dom.ts.
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { ConditionInspector } from "../../src/editor/ui/inspectors/ConditionInspector";
import { emptyBlock } from "../../src/editor/model/nodeFilter";
import type { ConditionNode, TableConfigRef } from "../../src/editor/model/types";

function baseCondition(over: Partial<ConditionNode> = {}): ConditionNode {
  return {
    id: "c1", name: "Line check", tableConfigId: "lines", conditionType: "FieldComparison",
    comparisonColumn: null, comparisonOperator: null, valueSource: null,
    comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null, expression: null, filter: null,
    ...over,
  };
}

const TABLE_CONFIGS: Record<string, TableConfigRef> = {
  root: {
    id: "root", name: "Account", tableLogicalName: "account", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
  },
  lines: {
    id: "lines", name: "Order lines", tableLogicalName: "account_line", tableConfigType: "ChildTable",
    parentTableConfigId: "root", lookupColumnLogicalName: null, childLinkField: "accountid", lookupTargetIdAttribute: null,
  },
};

const META = fakeMetadata({
  account: [col({ logicalName: "name", displayName: "Account name" })],
  account_line: [
    col({ logicalName: "amount", displayName: "Amount", attributeType: "Money" }),
    col({ logicalName: "notes", displayName: "Notes" }),
  ],
});

// Stateful harness: applies each onPatch to the condition and re-renders, like the real
// editor's reducer-backed inspector host. Also records every patch for assertions.
function Harness({ initial, onPatch }: { initial: ConditionNode; onPatch(p: Partial<ConditionNode>): void }) {
  const [condition, setCondition] = React.useState(initial);
  return (
    <ConditionInspector
      condition={condition} ruleTable="account" tableConfigs={TABLE_CONFIGS}
      onPatch={(p) => { onPatch(p); setCondition((c) => ({ ...c, ...p })); }}
    />
  );
}

// Open the filter modal (the drawer only shows a summary + "Edit filters…" button).
async function openDialog() {
  fireEvent.click(await screen.findByRole("button", { name: /edit filters/i }));
}

describe("ConditionInspector — node-filter section (summary + modal)", () => {
  it("shows the section with an 'Edit filters…' button on a child-node condition", async () => {
    renderWithMeta(<Harness initial={baseCondition()} onPatch={() => {}} />, META);
    expect(await screen.findByText("Only consider records where…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit filters/i })).toBeInTheDocument();
    // No inline builder in the drawer: the column picker only exists inside the modal.
    expect(screen.queryByRole("combobox", { name: "Filter column" })).toBeNull();
  });

  it("summarizes existing filters in the drawer", async () => {
    const filled = {
      targetNodeId: "lines",
      root: {
        kind: "group" as const, id: "g1", op: "and" as const,
        rules: [{
          kind: "rule" as const, id: "r1", column: "amount", operator: 3,
          valueSource: 1, value: "100", valueNodeId: null, valueColumn: null,
        }],
      },
    };
    renderWithMeta(<Harness initial={baseCondition({ filter: [filled] })} onPatch={() => {}} />, META);
    // One complete criterion on the condition's own collection.
    expect(await screen.findByText(/\(this record's collection\) · 1 condition/)).toBeInTheDocument();
  });

  it("does not show the section for a non-child (root) node", () => {
    renderWithMeta(<Harness initial={baseCondition({ tableConfigId: "root" })} onPatch={() => {}} />, META);
    expect(screen.queryByText("Only consider records where…")).toBeNull();
  });

  it("does not show the section for an Expression condition", () => {
    renderWithMeta(<Harness initial={baseCondition({ conditionType: "Expression" })} onPatch={() => {}} />, META);
    expect(screen.queryByText("Only consider records where…")).toBeNull();
  });

  it("opening the modal renders the builder for an existing block", async () => {
    renderWithMeta(
      <Harness initial={baseCondition({ filter: [emptyBlock("lines")] })} onPatch={() => {}} />, META,
    );
    // Not rendered until the modal opens.
    expect(screen.queryByRole("combobox", { name: "Filter column" })).toBeNull();
    await openDialog();
    expect(await screen.findByRole("combobox", { name: "Filter column" })).toBeInTheDocument();
  });

  it("'Add filter' in the modal + Apply commits a block defaulted to the condition's own node", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<Harness initial={baseCondition()} onPatch={onPatch} />, META);

    await openDialog();
    // Working copy: adding a filter does not patch the condition yet.
    fireEvent.click(await screen.findByRole("button", { name: /^add filter$/i }));
    expect(onPatch).not.toHaveBeenCalled();

    // Apply commits the working copy.
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    expect(onPatch).toHaveBeenCalledTimes(1);
    const patch = onPatch.mock.calls[0][0] as Partial<ConditionNode>;
    expect(patch.filter).toHaveLength(1);
    expect(patch.filter![0].targetNodeId).toBe("lines");
  });

  it("Cancel discards working-copy edits", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<Harness initial={baseCondition()} onPatch={onPatch} />, META);

    await openDialog();
    fireEvent.click(await screen.findByRole("button", { name: /^add filter$/i }));
    // The added block shows a target-node picker inside the modal…
    expect(await screen.findByRole("combobox", { name: "Filter target node" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /^cancel$/i }));
    expect(onPatch).not.toHaveBeenCalled();

    // …and reopening re-seeds from the (unchanged) condition, so the cancelled block is gone.
    await openDialog();
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Filter target node" })).toBeNull());
  });

  it("the block's target-node picker (in the modal) lists the child (default) and the root ancestor", async () => {
    renderWithMeta(
      <Harness initial={baseCondition({ filter: [emptyBlock("lines")] })} onPatch={() => {}} />, META,
    );
    await openDialog();
    const targetBox = await screen.findByRole("combobox", { name: "Filter target node" });
    expect(targetBox).toHaveTextContent("(this record's collection)");
    fireEvent.click(targetBox);
    expect(await screen.findByRole("option", { name: "(this record's collection)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Account" })).toBeInTheDocument();
  });

  it("picking a column then an ordering operator shows a value cell (in the modal)", async () => {
    renderWithMeta(
      <Harness initial={baseCondition({ filter: [emptyBlock("lines")] })} onPatch={() => {}} />, META,
    );
    await openDialog();

    expect(screen.queryByRole("combobox", { name: "Filter value source" })).toBeNull();

    const colBox = await screen.findByRole("combobox", { name: "Filter column" });
    fireEvent.click(colBox);
    fireEvent.click(await screen.findByRole("option", { name: /^Amount/ }));

    const opBox = await screen.findByRole("combobox", { name: "Filter operator" });
    fireEvent.click(opBox);
    fireEvent.click(await screen.findByRole("option", { name: "Greater than" }));

    expect(await screen.findByRole("combobox", { name: "Filter value source" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Filter value" })).toBeInTheDocument();
  });

  it("the Literal/From-record source toggle switches the value cell (in the modal)", async () => {
    const filled = {
      targetNodeId: "lines",
      root: {
        kind: "group" as const, id: "g1", op: "and" as const,
        rules: [{
          kind: "rule" as const, id: "r1", column: "amount", operator: 3,
          valueSource: 1, value: null, valueNodeId: null, valueColumn: null,
        }],
      },
    };
    renderWithMeta(<Harness initial={baseCondition({ filter: [filled] })} onPatch={() => {}} />, META);
    await openDialog();

    expect(await screen.findByRole("textbox", { name: "Filter value" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Filter value node" })).toBeNull();

    const sourceBox = screen.getByRole("combobox", { name: "Filter value source" });
    fireEvent.click(sourceBox);
    fireEvent.click(await screen.findByRole("option", { name: "From record" }));

    expect(await screen.findByRole("combobox", { name: "Filter value node" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Filter value" })).toBeNull();
  });
});
