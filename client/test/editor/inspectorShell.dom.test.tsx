import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { InspectorShell } from "../../src/editor/ui/InspectorShell";

const header = { eyebrow: "Editing group", title: "My group" };

describe("InspectorShell — docked", () => {
  it("is rendered without an open prop and shows header + body + issues", () => {
    renderWithFluent(
      <InspectorShell mode="docked" header={header} issues={<div>issue-slot</div>}>
        <div>panel-body</div>
      </InspectorShell>,
    );
    expect(screen.getByText("My group")).toBeInTheDocument();
    expect(screen.getByText("panel-body")).toBeInTheDocument();
    expect(screen.getByText("issue-slot")).toBeInTheDocument();
  });

  it("does NOT steal focus on mount (persistent layout must not trap)", async () => {
    renderWithFluent(
      <InspectorShell mode="docked" header={header}><div>b</div></InspectorShell>,
    );
    // Flush any rAF queued during mount: the overlay's focus steal is rAF-deferred,
    // and a synchronous assertion would run before it fires.
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    expect(screen.getByTestId("inspector-heading")).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it("hides the close button when onClose is not provided", () => {
    renderWithFluent(
      <InspectorShell mode="docked" header={header}><div>b</div></InspectorShell>,
    );
    expect(screen.queryByRole("button", { name: "Close inspector" })).toBeNull();
  });

  it("Escape inside the panel calls onClose; Escape outside does not", () => {
    const onClose = vi.fn();
    renderWithFluent(
      <>
        <input aria-label="outside" />
        <InspectorShell mode="docked" header={header} onClose={onClose}>
          <input aria-label="inside" />
        </InspectorShell>
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("inside"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText("outside"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1); // unchanged: scoped, not document-level
  });
});

describe("InspectorShell — overlay (the moved drawer contract)", () => {
  const overlay = (open: boolean, onClose = () => {}) => (
    <InspectorShell mode="overlay" open={open} header={header} onClose={onClose}>
      <div>panel-body</div>
    </InspectorShell>
  );

  it("has a labelled close button when open", () => {
    renderWithFluent(overlay(true));
    expect(screen.getByRole("button", { name: "Close inspector" })).toBeInTheDocument();
  });

  it("moves focus into the panel heading on open", async () => {
    renderWithFluent(overlay(true));
    await waitFor(() => expect(screen.getByTestId("inspector-heading")).toHaveFocus());
  });

  it("Escape closes it exactly once (document-level listener)", async () => {
    const onClose = vi.fn();
    renderWithFluent(overlay(true, onClose));
    await waitFor(() => expect(screen.getByTestId("inspector-heading")).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the opener on close", async () => {
    const shell = (open: boolean) => (
      <>
        <button>opener</button>
        <InspectorShell mode="overlay" open={open} header={header} onClose={() => {}}>
          <div>b</div>
        </InspectorShell>
      </>
    );
    const { rerender } = renderWithFluent(shell(false));
    screen.getByRole("button", { name: "opener" }).focus();
    rerender(<AppProvider>{shell(true)}</AppProvider>);
    await waitFor(() => expect(screen.getByTestId("inspector-heading")).toHaveFocus());
    rerender(<AppProvider>{shell(false)}</AppProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "opener" })).toHaveFocus());
  });
});
