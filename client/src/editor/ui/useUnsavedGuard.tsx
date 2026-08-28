import * as React from "react";
import { ConfirmDiscardDialog } from "./ConfirmDiscardDialog";

// Guards edit-loss on the two dirty-capable screens (rule editor, tableconfig editor):
// a beforeunload prompt while dirty, and an in-app "Discard unsaved changes?" dialog in
// front of any deferred action that would drop the working state (navigate, reload).
export function useUnsavedGuard(dirty: boolean): {
  confirmNavigate(action: () => void): void;
  guardDialog: React.ReactNode;
} {
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;
  const pendingRef = React.useRef<(() => void) | null>(null);
  // Set when the user chose Discard: navigate() is a real page unload, so without the
  // bypass the beforeunload handler would raise a second, native prompt.
  const bypassRef = React.useRef(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!dirty) return;
    // Re-arming after a Discard (e.g. an in-app Reload followed by new edits) must
    // clear the bypass, and this is the only timing-safe point to do it: the unload
    // from a discarded navigate() fires after the current script yields, so resetting
    // synchronously inside onDiscard would re-enable the prompt it just bypassed.
    bypassRef.current = false;
    const handler = (e: BeforeUnloadEvent) => {
      if (bypassRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const confirmNavigate = React.useCallback((action: () => void) => {
    if (!dirtyRef.current) { action(); return; }
    pendingRef.current = action;
    setOpen(true);
  }, []);

  const onCancel = React.useCallback(() => { pendingRef.current = null; setOpen(false); }, []);
  const onDiscard = React.useCallback(() => {
    const action = pendingRef.current;
    pendingRef.current = null;
    bypassRef.current = true;
    setOpen(false);
    action?.();
  }, []);

  const guardDialog = <ConfirmDiscardDialog open={open} onCancel={onCancel} onDiscard={onDiscard} />;
  return { confirmNavigate, guardDialog };
}
