import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { useUnsavedGuard } from "../../src/editor/ui/useUnsavedGuard";

// Harness: a button that routes an action through confirmNavigate, plus the hook's dialog.
function Harness({ dirty, action }: { dirty: boolean; action: () => void }) {
  const { confirmNavigate, guardDialog } = useUnsavedGuard(dirty);
  return (
    <>
      <button type="button" onClick={() => confirmNavigate(action)}>Go</button>
      {guardDialog}
    </>
  );
}

const fireBeforeUnload = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

describe("useUnsavedGuard", () => {
  it("clean: runs the action immediately, no dialog", () => {
    const action = vi.fn();
    renderWithFluent(<Harness dirty={false} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });

  it("dirty: opens the dialog; Cancel keeps the action unrun and closes", async () => {
    const action = vi.fn();
    renderWithFluent(<Harness dirty action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(action).not.toHaveBeenCalled();
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });

  it("dirty: Discard runs the action once", async () => {
    const action = vi.fn();
    renderWithFluent(<Harness dirty action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await screen.findByText("Discard unsaved changes?");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("beforeunload: prevented while dirty, not when clean, not after unmount", () => {
    // renderWithFluent wraps in AppProvider, so rerender must re-wrap the same way.
    const first = renderWithFluent(<Harness dirty={false} action={() => {}} />);
    expect(fireBeforeUnload()).toBe(false);
    first.unmount();
    const second = renderWithFluent(<Harness dirty action={() => {}} />);
    expect(fireBeforeUnload()).toBe(true);
    second.unmount();
    expect(fireBeforeUnload()).toBe(false);
  });

  it("beforeunload: bypassed after Discard (the discarded navigate must not re-prompt)", async () => {
    renderWithFluent(<Harness dirty action={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await screen.findByText("Discard unsaved changes?");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    // Still dirty (the harness never saves), but the unload triggered by the discarded
    // action must go through silently.
    expect(fireBeforeUnload()).toBe(false);
  });
});
