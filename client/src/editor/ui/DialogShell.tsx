import * as React from "react";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger, Button,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";

/**
 * The one dialog frame: title + a 32×32 close button, content with a 16px gap,
 * and right-aligned actions ([secondary] [primary], 8px apart).
 */
export function DialogShell({
  open, title, onClose, actions, children, width = 600, modalType, surfaceRef, closeDisabled,
}: {
  open: boolean;
  title: React.ReactNode;
  onClose(): void;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  width?: number;
  modalType?: "modal" | "alert" | "non-modal";
  surfaceRef?: React.Ref<HTMLDivElement>;
  /** Hides the close button and ignores Esc / backdrop (e.g. while a run is busy). */
  closeDisabled?: boolean;
}) {
  return (
    <Dialog open={open} modalType={modalType}
      onOpenChange={(_e, d) => { if (!d.open && !closeDisabled) onClose(); }}>
      <DialogSurface ref={surfaceRef} style={{ maxWidth: `min(${width}px, calc(100vw - 32px))`, width: "100%" }}>
        <DialogBody>
          <DialogTitle
            action={closeDisabled ? null : (
              <DialogTrigger action="close">
                <Button appearance="subtle" aria-label="Close dialog" icon={<Dismiss20Regular />}
                  style={{ minWidth: 32, width: 32, height: 32 }} />
              </DialogTrigger>
            )}
          >
            {title}
          </DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {children}
          </DialogContent>
          {actions && (
            <DialogActions position="end" style={{ gap: 8 }}>
              {actions}
            </DialogActions>
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
