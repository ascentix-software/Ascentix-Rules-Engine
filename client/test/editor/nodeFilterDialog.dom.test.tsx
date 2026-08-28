import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { TABLE_CONFIGS, TC_LIST, META } from "./nodeFilterFixtures";
import { renderWithMeta } from "./metaFixtures";
import { NodeFilterDialog } from "../../src/editor/ui/inspectors/NodeFilterDialog";
import type { ConditionNode } from "../../src/editor/model/types";

// The dialog seeds its working copy from condition.filter (see NodeFilterDialog's effect), and
// "Add filter" seeds a fresh block via emptyBlock(condition.tableConfigId), so tableConfigId
// must reference a real node ("lines", the shared fixtures' ChildTable) for the block's target
// dropdown / NodeFilterBuilder to have somewhere to point.
function baseCondition(over: Partial<ConditionNode> = {}): ConditionNode {
  return {
    id: "c1", name: "Line check", tableConfigId: "lines", conditionType: "FieldComparison",
    comparisonColumn: null, comparisonOperator: null, valueSource: null,
    comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null, expression: null, filter: null,
    ...over,
  };
}

const EMPTY_TEXT = "No filters yet. This condition evaluates every record. Add a filter to narrow it.";

// Dialog content renders into a Fluent portal appended to document.body, outside the
// render()'d container, so block/divider counts are queried against the document, matching
// the pattern in fieldMappingDialog.dom.test.tsx (document.querySelector for portal content).
function filterBlockCount() {
  return document.querySelectorAll("[data-filter-block]").length;
}

function addFilter() {
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
}

describe("NodeFilterDialog — block add/remove/apply/cancel wiring", () => {
  it("renders open with no filter: empty-state text present, no filter blocks", () => {
    renderWithMeta(
      <NodeFilterDialog open condition={baseCondition()} tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
        onCancel={vi.fn()} onApply={vi.fn()} />,
      META,
    );
    expect(screen.getByText(EMPTY_TEXT)).toBeInTheDocument();
    expect(filterBlockCount()).toBe(0);
  });

  it("clicking 'Add filter' adds one block and clears the empty-state", () => {
    renderWithMeta(
      <NodeFilterDialog open condition={baseCondition()} tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
        onCancel={vi.fn()} onApply={vi.fn()} />,
      META,
    );
    addFilter();
    expect(filterBlockCount()).toBe(1);
    expect(screen.queryByText(EMPTY_TEXT)).not.toBeInTheDocument();
  });

  it("adding two filters renders exactly one AND divider", () => {
    renderWithMeta(
      <NodeFilterDialog open condition={baseCondition()} tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
        onCancel={vi.fn()} onApply={vi.fn()} />,
      META,
    );
    addFilter();
    addFilter();
    expect(filterBlockCount()).toBe(2);
    expect(screen.queryAllByTestId("nf-and-divider").length).toBe(1);
  });

  it("removing a block returns the dialog to the empty-state", () => {
    renderWithMeta(
      <NodeFilterDialog open condition={baseCondition()} tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
        onCancel={vi.fn()} onApply={vi.fn()} />,
      META,
    );
    addFilter();
    expect(filterBlockCount()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove filter" }));
    expect(filterBlockCount()).toBe(0);
    expect(screen.getByText(EMPTY_TEXT)).toBeInTheDocument();
  });

  it("clicking Cancel calls onCancel and not onApply", () => {
    const onCancel = vi.fn();
    const onApply = vi.fn();
    renderWithMeta(
      <NodeFilterDialog open condition={baseCondition()} tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
        onCancel={onCancel} onApply={onApply} />,
      META,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("adding a filter then clicking Apply calls onApply with a one-block array", () => {
    const onApply = vi.fn();
    renderWithMeta(
      <NodeFilterDialog open condition={baseCondition()} tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
        onCancel={vi.fn()} onApply={onApply} />,
      META,
    );
    addFilter();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const blocks = onApply.mock.calls[0][0];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBe(1);
  });
});
