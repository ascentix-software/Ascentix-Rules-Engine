import { describe, it, expect } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { renderNodeFilterHarness, TABLE_CONFIGS, TC_LIST, META } from "./nodeFilterFixtures";
import { renderWithMeta } from "./metaFixtures";
import { NodeFilterDialog } from "../../src/editor/ui/inspectors/NodeFilterDialog";
import { emptyBlock, emptyGroup, emptyLeaf, type NodeFilterGroupModel } from "../../src/editor/model/nodeFilter";
import type { ConditionNode } from "../../src/editor/model/types";

// Root builder scoped to "account" (currentNodeId "root"). The exists-suite's own fixture is
// scoped to "account_line"/"lines" instead, since its scenarios are all about the EXISTS row;
// this file exercises the plain-frame/nested-group/Add-menu/from-record spine, which reads more
// naturally at the root.
function renderBuilder(opts: { withNestedGroup?: boolean; withLeafHavingOperator?: boolean } = {}) {
  // A LITERAL empty group ({ rules: [] }), not the model's emptyGroup() helper, which seeds one
  // blank leaf by default. These scenarios need to control the exact starting row count (zero,
  // so "each menu item appends its kind" can assert on exactly one row after adding).
  let initial: NodeFilterGroupModel = { ...emptyGroup(), rules: [] };
  if (opts.withNestedGroup) {
    initial = { ...initial, rules: [emptyGroup()] };
  } else if (opts.withLeafHavingOperator) {
    initial = { ...initial, rules: [{ ...emptyLeaf(), column: "name", operator: 1 }] };
  }
  return renderNodeFilterHarness({ initial, table: "account", currentNodeId: "root" });
}

describe("NodeFilterBuilder — grouped spine", () => {
  it("the root builder has a plain frame (no rail)", () => {
    renderBuilder(); // empty group at root
    const root = screen.getByTestId("nf-root");
    // jsdom expands the `border` shorthand onto every longhand (including borderLeft), so a
    // plain 1px frame reads back as "1px solid <line>" on borderLeft too: the absence of a
    // rail is that it's the SAME 1px line color, not a distinct 4px zone rail.
    expect(root.style.borderLeft).toBe("1px solid rgb(231, 232, 240)"); // 1px line, no 4px rail
    expect(root.style.border).toContain("1px solid");                  // the plain frame
  });

  it("a nested group gets the execution rail and tinted header", () => {
    renderBuilder({ withNestedGroup: true }); // seed value with one child group
    const shell = screen.getByTestId("nf-group-shell");
    expect(shell.style.borderLeft).toBe("4px solid rgb(74, 68, 201)");   // execution
    const head = within(shell).getByTestId("nf-group-head");
    expect(head.style.background).toBe("rgb(237, 236, 251)");            // executionTint
  });

  it("the Add menu offers exactly three item kinds at root", async () => {
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Condition", "Group", "Related-rows filter"]);
  });

  it("each menu item appends its kind", async () => {
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Condition" }));
    // ColumnPicker fetches its own columns on mount (fakeMetadata resolves async, no cache): a
    // freshly-appended row renders a Spinner for one tick before the Combobox appears.
    expect(await screen.findByRole("combobox", { name: "Filter column" })).toBeInTheDocument();
  });

  it("From-record drops the node/column pickers to a full-width sub-row", async () => {
    renderBuilder({ withLeafHavingOperator: true }); // seed a leaf w/ column+operator (valued op)
    const source = screen.getByRole("combobox", { name: "Filter value source" });
    fireEvent.click(source);
    fireEvent.click(await screen.findByRole("option", { name: "From record" }));
    const subRow = screen.getByTestId("nf-fromrecord-subrow");
    expect(within(subRow).getByRole("combobox", { name: "Filter value node" })).toBeInTheDocument();
    // Same async-mount-Spinner note as above: this ColumnPicker is brand new in this sub-row.
    expect(await within(subRow).findByRole("combobox", { name: "Filter value column" })).toBeInTheDocument();
    // Literal keeps the sub-row absent:
    fireEvent.click(source);
    fireEvent.click(await screen.findByRole("option", { name: "Literal" }));
    expect(screen.queryByTestId("nf-fromrecord-subrow")).toBeNull();
  });
});

// Mounts NodeFilterDialog directly (not via ConditionInspector's "Edit filters…" gate, which
// nodeFilterBuilder.dom.test.tsx already covers) with `n` blocks all targeting the
// condition's own node ("lines"), to assert the per-block chrome the dialog itself owns.
function renderDialogWithBlocks(n: number) {
  const condition: ConditionNode = {
    id: "c1", name: "Filter cond", tableConfigId: "lines", conditionType: "FieldComparison",
    comparisonColumn: null, comparisonOperator: null, valueSource: null,
    comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null, expression: null,
    filter: Array.from({ length: n }, () => emptyBlock("lines")),
  };
  return renderWithMeta(
    <NodeFilterDialog open condition={condition} tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
      onCancel={() => {}} onApply={() => {}} />,
    META,
  );
}

describe("NodeFilterDialog — blocks as node sections", () => {
  it("titles each block 'Filter on' with the target dropdown", () => {
    renderDialogWithBlocks(2);
    expect(screen.getAllByText("Filter on")).toHaveLength(2);
  });
  it("renders exactly n-1 AND dividers between blocks", () => {
    renderDialogWithBlocks(2);
    expect(screen.getAllByTestId("nf-and-divider")).toHaveLength(1);
    expect(within(screen.getByTestId("nf-and-divider")).getByText(/must also match/i)).toBeInTheDocument();
  });
  it("renders no divider for a single block", () => {
    renderDialogWithBlocks(1);
    expect(screen.queryByTestId("nf-and-divider")).toBeNull();
  });
});
