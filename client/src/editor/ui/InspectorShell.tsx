import * as React from "react";
import {
  OverlayDrawer, DrawerHeader, DrawerBody, Button,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { color } from "./tokens";

export interface InspectorHeader {
  eyebrow: string; title: string; icon?: React.ReactNode;
  /** Optional ⋯ menu, rendered before Close. */
  menu?: React.ReactNode;
}

function PanelHeader({ header, onClose, headingRef }: {
  header: InspectorHeader; onClose?: () => void;
  headingRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px", borderBottom: `1px solid ${color.line}`, flex: "none" }}>
      {header.icon}
      <div ref={headingRef} tabIndex={-1} data-testid="inspector-heading"
        style={{ display: "flex", flexDirection: "column", lineHeight: 1.3, outline: "none", minWidth: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: color.inkMuted }}>{header.eyebrow}</span>
        <span style={{ fontSize: 14.5, fontWeight: 700, color: color.ink }}>{header.title}</span>
      </div>
      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 2 }}>
        {header.menu}
        {onClose && (
          <Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close inspector" onClick={onClose} />
        )}
      </span>
    </div>
  );
}

/** Docked: persistent layout region. Never traps focus; Escape is scoped to the panel. */
function DockedShell({ header, onClose, issues, children }: {
  header: InspectorHeader; onClose?: () => void; issues?: React.ReactNode; children: React.ReactNode;
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented && onClose) onClose();
  };
  return (
    <div onKeyDown={onKeyDown} style={{
      width: 352, flex: "0 0 352px", position: "sticky", top: 16, alignSelf: "flex-start",
      border: `1px solid ${color.line}`, borderRadius: 12, background: color.surface,
      overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,.05)",
      maxHeight: "calc(100vh - 32px)", display: "flex", flexDirection: "column",
    }}>
      <PanelHeader header={header} onClose={onClose} />
      <div data-testid="inspector-body" style={{ padding: 18, overflowY: "auto", minHeight: 0 }}>
        {issues}
        {children}
      </div>
    </div>
  );
}

/** Overlay: the drawer mechanics moved verbatim from the retired Inspector.tsx. */
function OverlayShell({ open, header, onClose, issues, children }: {
  open: boolean; header: InspectorHeader; onClose?: () => void;
  issues?: React.ReactNode; children: React.ReactNode;
}) {
  const headingRef = React.useRef<HTMLDivElement>(null);
  const returnRef = React.useRef<HTMLElement | null>(null);
  const prevOpen = React.useRef(false);

  // Capture the pre-open focus target synchronously during render (before the
  // drawer commits and Fluent's own tabster restorer shifts focus onto the
  // drawer surface). An effect would run after OverlayDrawer's own child
  // effects (children fire before parents), which is too late: by then
  // document.activeElement is already the drawer, not the opener.
  if (open && !prevOpen.current) {
    returnRef.current = (typeof document !== "undefined" ? (document.activeElement as HTMLElement) : null) ?? null;
  }
  prevOpen.current = open;

  React.useEffect(() => {
    if (open) {
      // Focus the panel heading once the drawer content is mounted.
      const id = requestAnimationFrame(() => headingRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    returnRef.current?.focus?.();
    returnRef.current = null;
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <OverlayDrawer position="end" open={open} modalType="non-modal"
      onOpenChange={(_, data) => { if (!data.open) onClose?.(); }}
      style={{ width: 330, maxWidth: "92vw", boxShadow: "-8px 0 24px rgba(0,0,0,.10)" }}>
      <DrawerHeader style={{ padding: 0 }}>
        <PanelHeader header={header} onClose={onClose} headingRef={headingRef} />
      </DrawerHeader>
      <DrawerBody style={{ padding: 18 }}>
        {issues}
        {children}
      </DrawerBody>
    </OverlayDrawer>
  );
}

/**
 * The one edit surface's chrome. Content routing is screen-owned by design:
 * the shell knows nothing about rules, nodes, or graphs, which is what makes
 * a drifted "reduced branch" structurally impossible.
 */
export const InspectorShell: React.FC<{
  mode: "docked" | "overlay";
  header: InspectorHeader;
  onClose?: () => void;
  open?: boolean;
  issues?: React.ReactNode;
  children: React.ReactNode;
}> = ({ mode, header, onClose, open = false, issues, children }) =>
  mode === "docked"
    ? <DockedShell header={header} onClose={onClose} issues={issues}>{children}</DockedShell>
    : <OverlayShell open={open} header={header} onClose={onClose} issues={issues}>{children}</OverlayShell>;

/**
 * A collapsible inspector section (an Accordion item). The open state persists per
 * section for the tab's session under asx.inspector.<id>. `summary` shows while
 * collapsed. Sections sit flush: the inspector body's padding is cancelled with
 * negative margins so the header rows span the panel.
 */
export const InspectorSection: React.FC<{
  id: string; title: string; summary?: string; defaultOpen?: boolean; children: React.ReactNode;
}> = ({ id, title, summary, defaultOpen = false, children }) => {
  const key = `asx.inspector.${id}`;
  const [open, setOpen] = React.useState<boolean>(() => {
    try {
      const v = sessionStorage.getItem(key);
      return v == null ? defaultOpen : v === "1";
    } catch { return defaultOpen; }
  });
  const toggle = (next: boolean) => {
    setOpen(next);
    try { sessionStorage.setItem(key, next ? "1" : "0"); } catch { /* storage unavailable */ }
  };
  return (
    <Accordion collapsible multiple openItems={open ? [id] : []}
      onToggle={(_e, d) => toggle(d.openItems.includes(id))}
      style={{ margin: "0 -18px", borderBottom: `1px solid ${color.line}` }}>
      <AccordionItem value={id}>
        <AccordionHeader expandIconPosition="start" size="large"
          button={{ style: { padding: "12px 18px", minHeight: 0 } }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: color.ink }}>{title}</span>
            {!open && summary && (
              <span style={{ marginLeft: "auto", fontSize: 12.5, color: color.inkMuted, fontWeight: 400,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {summary}
              </span>
            )}
          </span>
        </AccordionHeader>
        <AccordionPanel style={{ margin: 0, padding: "4px 18px 16px" }}>
          {children}
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
};
