import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { TitleActionsRow } from "../../src/editor/ui/primitives";

function renderRow(stacked: boolean) {
  return render(
    <AppProvider>
      <TitleActionsRow stacked={stacked}
        left={<h1>Title</h1>}
        actions={<button type="button">Save</button>} />
    </AppProvider>,
  );
}

describe("TitleActionsRow", () => {
  it("keeps title and actions in one row (space-between) when wide", () => {
    renderRow(false);
    const row = screen.getByTestId("title-actions-row");
    expect(row.style.flexDirection).not.toBe("column");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("stacks actions below the title when narrow", () => {
    renderRow(true);
    const row = screen.getByTestId("title-actions-row");
    expect(row.style.flexDirection).toBe("column");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
