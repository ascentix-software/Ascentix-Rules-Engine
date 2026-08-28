import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { ConfirmDeleteDialog } from "../../src/editor/ui/hub/ConfirmDeleteDialog";

describe("ConfirmDeleteDialog", () => {
  it("renders with the name in the title and the confirmation message in the body", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    renderWithFluent(
      <ConfirmDeleteDialog open name="Credit rule" onCancel={onCancel} onConfirm={onConfirm} />
    );
    expect(screen.getByText("Delete Credit rule?")).toBeInTheDocument();
    expect(screen.getByText("This can't be undone.")).toBeInTheDocument();
  });

  it("calls onConfirm once when the Delete button is clicked", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    renderWithFluent(
      <ConfirmDeleteDialog open name="Credit rule" onCancel={onCancel} onConfirm={onConfirm} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel once when the Cancel button is clicked", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    renderWithFluent(
      <ConfirmDeleteDialog open name="Credit rule" onCancel={onCancel} onConfirm={onConfirm} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
