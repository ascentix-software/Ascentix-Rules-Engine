import * as React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dialog, DialogSurface, DialogBody, Button } from "@fluentui/react-components";
import { AppProvider } from "../../src/editor/ui/AppProvider";

// Regression guard for a jsdom-only Fluent/tabster interaction that silently makes *ByRole
// queries inside an open Dialog fail forever. See the `defaultHidden` note in test/setup.dom.ts.
//
// Fluent focuses the DialogSurface programmatically when a modal opens; tabster only marks the
// modalizer active (`setActive`) when it sees that focus as programmatic. If a test awaits a
// query before the click that opens the dialog, the ordering shifts, tabster never activates the
// modalizer, and its deferred hiddenUpdate() timer (Modalizer.cjs, setTimeout 250ms) then files
// the *modal itself* under `hiddenElements` and stamps aria-hidden="true" on the DialogSurface.
// Testing Library's *ByRole skips aria-hidden subtrees, so the dialog becomes unqueryable,
// permanently, so no findBy timeout can rescue it. A synchronous query beats the 250ms timer;
// an awaited one loses on a slow agent. Hence: green locally, red in CI.
function App() {
  const [open, setOpen] = React.useState(false);
  return (
    <AppProvider>
      <Button onClick={() => setOpen(true)}>Edit filters…</Button>
      <Dialog open={open}>
        <DialogSurface><DialogBody><Button>Cancel</Button></DialogBody></DialogSurface>
      </Dialog>
    </AppProvider>
  );
}

describe("Fluent Dialog content stays queryable by role", () => {
  it("finds a dialog button by role after an awaited query and tabster's hiddenUpdate", async () => {
    render(<App />);

    // Awaiting before the click is what shifts tabster's activation ordering. This mirrors the
    // real suite's `openDialog()` helper.
    fireEvent.click(await screen.findByRole("button", { name: /edit filters/i }));

    // Let tabster's 250ms hiddenUpdate timer fire, as a slow CI agent's awaited query would.
    await new Promise((r) => setTimeout(r, 1200));

    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
  });
});
