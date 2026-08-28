import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithMeta } from "./metaFixtures";
import { TABLE_CONFIGS, TC_LIST, META } from "./nodeFilterFixtures";
import { AggregateFilterDialog } from "../../src/editor/ui/inspectors/AggregateFilterDialog";
import { emptyGroup } from "../../src/editor/model/nodeFilter";

// Proves the dialog WRAPPER wires open/apply/cancel/close, not the NodeFilterBuilder internals
// (those are covered by nodeFilterBuilder.dom.test.tsx).
describe("AggregateFilterDialog", () => {
  it("renders open with the title and a queryable dialog role", async () => {
    const onCancel = vi.fn();
    const onApply = vi.fn();
    renderWithMeta(
      <AggregateFilterDialog open table="lines" tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
        value={emptyGroup()} onCancel={onCancel} onApply={onApply} />,
      META,
    );
    expect(await screen.findByText("Filter this aggregate…")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Cancel calls onCancel, not onApply", async () => {
    const onCancel = vi.fn();
    const onApply = vi.fn();
    renderWithMeta(
      <AggregateFilterDialog open table="lines" tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
        value={emptyGroup()} onCancel={onCancel} onApply={onApply} />,
      META,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("the Close icon button calls onCancel", async () => {
    const onCancel = vi.fn();
    const onApply = vi.fn();
    renderWithMeta(
      <AggregateFilterDialog open table="lines" tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
        value={emptyGroup()} onCancel={onCancel} onApply={onApply} />,
      META,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Apply calls onApply once with the working NodeFilterGroupModel", async () => {
    const onCancel = vi.fn();
    const onApply = vi.fn();
    const value = emptyGroup();
    renderWithMeta(
      <AggregateFilterDialog open table="lines" tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
        value={value} onCancel={onCancel} onApply={onApply} />,
      META,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(value);
  });
});
