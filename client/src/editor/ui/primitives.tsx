import * as React from "react";
import { Tooltip } from "@fluentui/react-components";
import {
  Info16Regular, Prohibited16Regular, Warning16Regular, Eye16Regular,
  Important16Regular, Add16Regular, Edit16Regular, Delete16Regular,
} from "@fluentui/react-icons";
import type { ActionTypeLabel } from "../model/types";
import { statusReasonLabel } from "../model/enums";
import { useEditorStyles } from "./styles";
import { color } from "./tokens";

// Re-export depthTint for potential future use by nested group fallback
export { depthTint } from "./styles";

export const NodeTag: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const s = useEditorStyles();
  return <span className={s.nodeTag}>{children}</span>;
};
export const OperatorPill: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const s = useEditorStyles();
  return <span className={s.operatorPill}>{children}</span>;
};
export const ValueText: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const s = useEditorStyles();
  return <span className={s.valueText}>{children}</span>;
};

export const LogicalBadge: React.FC<{ operator: "And" | "Or" }> = ({ operator }) => {
  const s = useEditorStyles();
  return (
    <span className={`${s.badge} ${operator === "And" ? s.andBadge : s.orBadge}`}>
      {operator === "And" ? "ALL · AND" : "ANY · OR"}
    </span>
  );
};

export const TitleActionsRow: React.FC<{
  left: React.ReactNode; actions: React.ReactNode; stacked: boolean;
}> = ({ left, actions, stacked }) => (
  <div data-testid="title-actions-row" style={{
    display: "flex", gap: stacked ? 12 : 16,
    ...(stacked
      ? { flexDirection: "column", alignItems: "stretch" }
      : { alignItems: "flex-start", justifyContent: "space-between" }),
  }}>
    <div style={{ minWidth: 0 }}>{left}</div>
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>{actions}</div>
  </div>
);

export const GroupCard: React.FC<{
  zone: "execution" | "validation"; nested: boolean; header: React.ReactNode; children?: React.ReactNode;
}> = ({ zone, nested, header, children }) => {
  const s = useEditorStyles();
  const accent = zone === "execution" ? color.execution : color.validation;
  const style: React.CSSProperties = nested
    ? { border: `1px solid ${color.line}`, borderLeft: `4px solid ${color.brandLine}`, borderRadius: 16,
        background: color.canvas, margin: "10px 0 4px 14px", padding: "8px 12px" }
    : { border: `1px solid ${color.line}`, borderLeft: `4px solid ${accent}`, borderRadius: 16,
        background: color.surface, marginTop: 10 };
  return (
    <div className={s.groupCard} style={style}>
      <div className={s.groupHeader}
        style={nested ? undefined : { padding: "10px 14px 8px", borderBottom: `1px solid ${color.line}` }}>
        {header}
      </div>
      {children}
    </div>
  );
};

export const ACTION_CHIP: Record<ActionTypeLabel, { bg: string; fg: string }> = {
  Block: { bg: color.dangerTint, fg: color.danger },
  ShowMessage: { bg: color.warnTint, fg: color.warnInk },
  SetVisible: { bg: color.actionTint, fg: color.action },
  SetRequired: { bg: color.actionTint, fg: color.action },
  CreateRecord: { bg: color.actionTint, fg: color.action },
  UpdateRecord: { bg: color.actionTint, fg: color.action },
  DeleteRecord: { bg: color.actionTint, fg: color.action },
};

const ACTION_ICON: Record<ActionTypeLabel, React.ReactElement> = {
  Block: <Prohibited16Regular />, ShowMessage: <Warning16Regular />,
  SetVisible: <Eye16Regular />, SetRequired: <Important16Regular />,
  CreateRecord: <Add16Regular />, UpdateRecord: <Edit16Regular />, DeleteRecord: <Delete16Regular />,
};

export const ActionIcon: React.FC<{ actionType: ActionTypeLabel | null }> = ({ actionType }) => {
  const s = useEditorStyles();
  const chip = actionType ? ACTION_CHIP[actionType] : { bg: color.fill, fg: color.inkMuted };
  return (
    <div className={s.actionIcon} style={{ background: chip.bg, color: chip.fg }}>
      {actionType ? ACTION_ICON[actionType] : <Info16Regular />}
    </div>
  );
};

export function statusTone(statusCode: number | null): PillTone {
  return statusCode === 753840000 ? "published" : statusCode === 2 ? "archived" : "draft";
}

export const StatusBadge: React.FC<{ statusCode: number | null }> = ({ statusCode }) => (
  <Pill tone={statusTone(statusCode)}>{statusReasonLabel(statusCode)}</Pill>
);

export const InfoTip: React.FC<{ text: string }> = ({ text }) => (
  <Tooltip content={text} relationship="label">
    <Info16Regular style={{ color: color.inkMuted, cursor: "help" }} />
  </Tooltip>
);

/**
 * The one eyebrow treatment. Replaces ~6 hand-built uppercase labels, several
 * of which used a grey that failed 1.4.3.
 */
export const Eyebrow: React.FC<{ variant?: "muted" | "brand"; children: React.ReactNode }> = ({
  variant = "muted", children,
}) => (
  <span style={{
    fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase",
    color: variant === "brand" ? color.brandInk : color.inkMuted,
  }}>
    {children}
  </span>
);

export type PillTone =
  | "draft" | "published" | "archived"
  | "danger" | "warn" | "info" | "write" | "neutral" | "collection";

/**
 * Every tone pairs a TEXT color with a TINT background, never a saturated fill
 * under white. `warn` in particular is a fill-only token (3.38:1); its pill uses
 * warnInk on warnTint (5.49:1). Pills always carry a label, so status is never
 * conveyed by color alone (WCAG 1.4.1).
 */
const PILL_TONE: Record<PillTone, { fg: string; bg: string }> = {
  draft: { fg: color.warnInk, bg: color.warnTint },
  published: { fg: color.success, bg: color.successTint },
  archived: { fg: color.inkMuted, bg: color.fill },
  danger: { fg: color.danger, bg: color.dangerTint },
  warn: { fg: color.warnInk, bg: color.warnTint },
  info: { fg: color.brandInk, bg: color.brandTint },
  write: { fg: color.action, bg: color.actionTint },
  neutral: { fg: color.inkMuted, bg: color.fill },
  collection: { fg: color.validation, bg: color.validationTint },
};

export const Pill: React.FC<{ tone: PillTone; children: React.ReactNode }> = ({ tone, children }) => {
  const { fg, bg } = PILL_TONE[tone];
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em",
      padding: "3px 9px", borderRadius: 999, color: fg, backgroundColor: bg,
      display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
};

/** The dirty-state chip both editors show. The dot is decoration (aria-hidden);
 *  the text carries the meaning (WCAG 1.4.1). */
export const UnsavedPill: React.FC = () => {
  const s = useEditorStyles();
  return (
    <Pill tone="warn">
      <span aria-hidden className={s.pulseDot} />
      Unsaved changes
    </Pill>
  );
};

type CalloutIntent = "info" | "success" | "warning" | "danger";

const CALLOUT_INTENT: Record<CalloutIntent, { fg: string; bg: string; line: string }> = {
  info: { fg: color.brandInk, bg: color.brandTint, line: color.brandLine },
  success: { fg: color.success, bg: color.successTint, line: color.success },
  warning: { fg: color.warnInk, bg: color.warnTint, line: color.warn },
  danger: { fg: color.danger, bg: color.dangerTint, line: color.danger },
};

/**
 * The one status-message surface. Consolidates the Fluent-banner-vs-hand-rolled
 * split, so role="alert" lives in exactly one place (WCAG 4.1.3).
 *
 * Only warning/danger are announced. info/success are context, not events:
 * announcing a persistent info banner on every render would spam a screen reader.
 */
export const Callout: React.FC<{
  intent: CalloutIntent; title?: string; children: React.ReactNode;
}> = ({ intent, title, children }) => {
  const t = CALLOUT_INTENT[intent];
  const announce = intent === "warning" || intent === "danger";
  return (
    <div
      {...(announce ? { role: "alert" as const } : {})}
      style={{
        border: `1px solid ${t.line}`, borderLeft: `4px solid ${t.line}`,
        borderRadius: 8, background: t.bg, padding: "10px 13px",
        display: "flex", flexDirection: "column", gap: 3,
      }}
    >
      {title ? <span style={{ fontSize: 12.5, fontWeight: 700, color: t.fg }}>{title}</span> : null}
      <span style={{ fontSize: 12.5, color: color.ink }}>{children}</span>
    </div>
  );
};

/**
 * The one field wrapper: the design system's label + control + hint block.
 * (The hand-rolled per-file field wrappers it replaced are all retired.)
 */
export const Field: React.FC<{
  label: string; hint?: string; required?: boolean; children: React.ReactNode;
}> = ({ label, hint, required, children }) => (
  <div style={{ marginBottom: 11, display: "flex", flexDirection: "column", gap: 3 }}>
    <span style={{ fontSize: 12.5, fontWeight: 600, color: color.ink }}>
      {label}{required ? <span style={{ color: color.danger }}> *</span> : null}
    </span>
    {children}
    {hint ? <span style={{ fontSize: 11.5, color: color.inkMuted }}>{hint}</span> : null}
  </div>
);
