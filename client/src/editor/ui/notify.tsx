import * as React from "react";
import {
  Toaster, Toast, ToastTitle, ToastTrigger, Button, Link, useToastController, tokens,
} from "@fluentui/react-components";
import { Dismiss20Regular, CheckmarkCircle20Regular } from "@fluentui/react-icons";
import { color } from "./tokens";

/** The one toaster id. AppProvider mounts the Toaster; useNotify dispatches to it. */
export const TOASTER_ID = "asx-toaster";

/** Mounted once, by the outermost AppProvider. Bottom-centre, 5s, pauses on hover. */
export const NotifyToaster: React.FC = () => (
  <Toaster toasterId={TOASTER_ID} position="bottom" timeout={5000} pauseOnHover limit={3} />
);

const InkToast: React.FC<{ text: string; icon?: boolean; action?: { label: string; onClick(): void } }> = ({ text, icon, action }) => (
  <Toast data-testid="toast"
    appearance="inverted"
    style={{
      background: color.ink, color: tokens.colorNeutralForegroundInverted, borderRadius: 8,
      padding: "10px 12px 10px 16px", boxShadow: "0 8px 24px rgba(23,23,60,.28)",
      display: "flex", alignItems: "center", gap: 12, minWidth: 0,
    }}
  >
    <ToastTitle
      media={icon ? <CheckmarkCircle20Regular style={{ color: tokens.colorNeutralForegroundInverted }} /> : null}
      action={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {action && (
            <ToastTrigger>
              <Link as="button" onClick={action.onClick}
                style={{ color: color.brandOnInk, fontWeight: 700, fontSize: 13.5 }}>
                {action.label}
              </Link>
            </ToastTrigger>
          )}
          <ToastTrigger>
            <Button appearance="transparent" size="small" icon={<Dismiss20Regular />} aria-label="Dismiss"
              style={{ color: tokens.colorNeutralForegroundInverted, minWidth: "auto" }} />
          </ToastTrigger>
        </span>
      }
    >
      <span style={{ fontSize: 13.5, color: tokens.colorNeutralForegroundInverted }}>{text}</span>
    </ToastTitle>
  </Toast>
);

export interface Notify {
  success(text: string, action?: { label: string; onClick(): void }): void;
  undo(text: string, onUndo: () => void): void;
  info(text: string): void;
}

/**
 * Transient confirmations only. Errors are never toasts: they stay inline until
 * dismissed (see the save-failure callout).
 */
export function useNotify(): Notify {
  const { dispatchToast } = useToastController(TOASTER_ID);
  return React.useMemo<Notify>(() => {
    const show = (text: string, icon: boolean, action?: { label: string; onClick(): void }) =>
      dispatchToast(<InkToast text={text} icon={icon} action={action} />, { intent: "info" });
    return {
      success: (text, action) => show(text, true, action),
      undo: (text, onUndo) => show(text, false, { label: "Undo", onClick: onUndo }),
      info: (text) => show(text, true),
    };
  }, [dispatchToast]);
}
