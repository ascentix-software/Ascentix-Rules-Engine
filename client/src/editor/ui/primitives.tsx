import * as React from "react";
import { Button, Tooltip, tokens, Field as FluentField, type FieldProps, RadioGroup, Radio } from "@fluentui/react-components";
import {
  Info16Regular, Prohibited16Regular, Warning16Regular, Eye16Regular,
  Important16Regular, Add16Regular, Edit16Regular, Delete16Regular, CircleOff16Regular, ErrorCircle16Regular,
} from "@fluentui/react-icons";
import type { ActionTypeLabel, ActionNode } from "../model/types";
import { statusReasonLabel } from "../model/enums";
import { actionEffect } from "./labels";
import { useEditorStyles } from "./styles";
import { color } from "./tokens";

// Re-export depthTint for potential future use by nested group fallback
export { depthTint } from "./styles";

export const NodeTag: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const s = useEditorStyles();
  return <span className={s.nodeTag}>{children}</span>;
};
export const ValueText: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const s = useEditorStyles();
  return <span className={s.valueText}>{children}</span>;
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

/**
 * A condition group. Top level: a 10px card with a header row. Nested: no card, just an
 * indented hairline rail, so depth reads without stacking borders. Neutral on purpose: the
 * zone colour lives on the band, not on every group.
 */
export const GroupCard: React.FC<{
  nested: boolean; header: React.ReactNode; children?: React.ReactNode;
}> = ({ nested, header, children }) => nested ? (
  <div style={{ margin: "4px 0 2px 10px", paddingLeft: 14, borderLeft: `2px solid ${color.line}` }}>
    <div style={{ padding: "2px 0" }}>{header}</div>
    <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 4 }}>{children}</div>
  </div>
) : (
  <div style={{ border: `1px solid ${color.line}`, borderRadius: 10, background: color.surface }}>
    <div style={{ padding: "9px 12px", borderBottom: `1px solid ${color.line}` }}>{header}</div>
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px 8px" }}>{children}</div>
  </div>
);

export const ACTION_CHIP: Record<ActionTypeLabel, { bg: string; fg: string }> = {
  Block: { bg: color.dangerTint, fg: color.danger },
  ShowMessage: { bg: color.warnTint, fg: color.warnInk },
  SetVisible: { bg: color.actionTint, fg: color.action },
  SetRequired: { bg: color.actionTint, fg: color.action },
  CreateRecord: { bg: color.actionTint, fg: color.action },
  UpdateRecord: { bg: color.actionTint, fg: color.action },
  DeleteRecord: { bg: color.actionTint, fg: color.action },
  DeactivateRecord: { bg: color.actionTint, fg: color.action },
};

const ACTION_ICON: Record<ActionTypeLabel, React.ReactElement> = {
  Block: <Prohibited16Regular />, ShowMessage: <Warning16Regular />,
  SetVisible: <Eye16Regular />, SetRequired: <Important16Regular />,
  CreateRecord: <Add16Regular />, UpdateRecord: <Edit16Regular />, DeleteRecord: <Delete16Regular />,
  DeactivateRecord: <CircleOff16Regular />,
};

// A message's icon follows its severity: Information (or unset) · Warning · Error.
const MESSAGE_LOOK: Record<number, { bg: string; fg: string; icon: React.ReactElement }> = {
  1: { bg: color.brandTint, fg: color.brandInk, icon: <Info16Regular /> },
  2: { bg: color.warnTint, fg: color.warnInk, icon: <Warning16Regular /> },
  3: { bg: color.dangerTint, fg: color.danger, icon: <ErrorCircle16Regular /> },
};

export const ActionIcon: React.FC<{ actionType: ActionTypeLabel | null; severity?: number | null }> = ({ actionType, severity }) => {
  const s = useEditorStyles();
  const message = actionType === "ShowMessage" ? MESSAGE_LOOK[severity ?? 1] ?? MESSAGE_LOOK[1] : null;
  const chip = message ?? (actionType ? ACTION_CHIP[actionType] : { bg: color.fill, fg: color.inkMuted });
  return (
    <div className={s.actionIcon} style={{ background: chip.bg, color: chip.fg }}>
      {message ? message.icon : actionType ? ACTION_ICON[actionType] : <Info16Regular />}
    </div>
  );
};

export function statusTone(statusCode: number | null): PillTone {
  return statusCode === 753840000 ? "published" : statusCode === 2 ? "archived" : "draft";
}

export const StatusBadge: React.FC<{ statusCode: number | null }> = ({ statusCode }) => (
  <Pill tone={statusTone(statusCode)}>{statusReasonLabel(statusCode)}</Pill>
);

/**
 * Help text behind an icon. A real (transparent) button so keyboard users can
 * focus it and read the tooltip; Esc closes it (Fluent Tooltip).
 */
export const InfoTip: React.FC<{ text: string; label?: string; tint?: string }> = ({ text, label, tint }) => (
  <Tooltip content={text} relationship="description" withArrow>
    <Button
      appearance="transparent" size="small" icon={<Info16Regular />}
      aria-label={label ? `More info: ${label}` : "More info"}
      onClick={(e) => e.preventDefault()}
      style={{ minWidth: "auto", width: 20, height: 20, padding: 0, color: tint ?? color.inkMuted, verticalAlign: "middle" }}
    />
  </Tooltip>
);

/** A label with its InfoTip inline after it (4px gap). Use for Fluent Field's label slot too. */
export const LabelWithInfo: React.FC<{ label: React.ReactNode; info?: string; required?: boolean; infoLabel?: string }> = ({
  label, info, required, infoLabel,
}) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
    <span>{label}{required ? <span style={{ color: color.danger }}> *</span> : null}</span>
    {info ? <InfoTip text={info} label={infoLabel ?? (typeof label === "string" ? label : undefined)} /> : null}
  </span>
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
 * The one field wrapper: the design system's label + control block. Explanatory
 * text goes behind `info` (an InfoTip); `hint` is for validation errors only.
 */
export const Field: React.FC<{
  label: string; info?: string; hint?: string; required?: boolean; children: React.ReactNode;
}> = ({ label, info, hint, required, children }) => (
  <div style={{ marginBottom: 11, display: "flex", flexDirection: "column", gap: 3 }}>
    <span style={{ fontSize: 12.5, fontWeight: 600, color: color.ink }}>
      <LabelWithInfo label={label} info={info} required={required} />
    </span>
    {children}
    {hint ? <span role="alert" style={{ fontSize: 11.5, color: color.danger }}>{hint}</span> : null}
  </div>
);

export interface SegmentOption<T extends string> { value: T; label: React.ReactNode; ariaLabel?: string; }

/**
 * A segmented single-choice toggle (radiogroup). Arrow keys move and select;
 * one segment is tabbable. MatchToggle, the condition mode switch, UTC/Local and
 * the Run dialog's Version toggle are all this control.
 */
export function SegmentedToggle<T extends string>({
  options, value, onChange, ariaLabel, fullWidth, disabled,
}: {
  options: SegmentOption<T>[]; value: T | null; onChange(v: T): void; ariaLabel: string;
  fullWidth?: boolean; disabled?: boolean;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (i: number) => {
    const n = (i + options.length) % options.length;
    onChange(options[n].value);
    refs.current[n]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} aria-disabled={disabled || undefined} style={{
      // Full width shares the spare room but never squeezes a label below its own width.
      display: fullWidth ? "flex" : "inline-flex",
      border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: 4, overflow: "hidden",
      background: color.surface, flex: "none",
    }}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value} type="button" role="radio" aria-checked={on}
            aria-label={o.ariaLabel} disabled={disabled}
            ref={(el) => { refs.current[i] = el; }}
            tabIndex={i === selectedIdx ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(i + 1); }
              if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(i - 1); }
            }}
            style={{
              flex: fullWidth ? "1 0 auto" : undefined,
              height: 24, padding: fullWidth ? "3px 8px" : "3px 12px", fontSize: 12, lineHeight: "16px", fontFamily: "inherit",
              border: 0, borderLeft: i === 0 ? 0 : `1px solid ${tokens.colorNeutralStroke1}`,
              background: on ? color.brand : "transparent",
              color: on ? tokens.colorNeutralForegroundOnBrand : color.ink,
              fontWeight: on ? 600 : 400, cursor: disabled ? "default" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export type MatchValue = "all" | "any";
export const toMatch = (op: "And" | "Or" | null | undefined): MatchValue => (op === "Or" ? "any" : "all");
export const fromMatch = (m: MatchValue): "And" | "Or" => (m === "any" ? "Or" : "And");

/**
 * All / Any. Edit mode is a 2-segment toggle; display mode is the tree's
 * neutral "Match all" badge (no zone colour on purpose).
 */
export const MatchToggle: React.FC<
  | { mode?: "edit"; value: MatchValue; onChange(v: MatchValue): void; ariaLabel: string; disabled?: boolean }
  | { mode: "display"; value: MatchValue }
> = (props) => {
  if (props.mode === "display") {
    return (
      <span style={{
        fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6,
        background: color.fill, color: color.ink, whiteSpace: "nowrap", flex: "none",
      }}>
        {props.value === "any" ? "Match any" : "Match all"}
      </span>
    );
  }
  return (
    <SegmentedToggle<MatchValue>
      ariaLabel={props.ariaLabel} value={props.value} onChange={props.onChange} disabled={props.disabled}
      options={[{ value: "all", label: "All" }, { value: "any", label: "Any" }]}
    />
  );
};

/** The action effect pill: every configured action gets one (Blocks save, Writes data, …). */
export const EffectPill: React.FC<{ action: ActionNode }> = ({ action }) => {
  const eff = actionEffect(action);
  if (!eff.label) return null;
  return <Pill tone={eff.tone}>{eff.label}</Pill>;
};

/**
 * Fluent's Field with an `info` InfoTip after the label. The tip renders OUTSIDE
 * the <label> element, so it never joins the control's accessible name.
 */
export const InfoField: React.FC<FieldProps & { info?: string }> = ({ info, label, ...rest }) => {
  if (!info || label == null) return <FluentField label={label} {...rest} />;
  const text = typeof label === "string" ? label : undefined;
  return (
    <FluentField
      {...rest}
      label={{
        children: (Component: React.ElementType, props: Record<string, unknown>) => (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Component {...props}>{label as React.ReactNode}{props.children as React.ReactNode}</Component>
            <InfoTip text={info} label={text} />
          </span>
        ),
      } as FieldProps["label"]}
    />
  );
};

/**
 * A slim bar for blocking states (data update, recovery) and the inline save
 * failure. Danger bars are announced (role="alert"); warn bars are context.
 */
export const NoticeBar: React.FC<{
  tone: "warn" | "danger";
  icon: React.ReactNode;
  lead?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  testId?: string;
}> = ({ tone, icon, lead, children, actions, testId }) => {
  const danger = tone === "danger";
  return (
    <div data-testid={testId} {...(danger ? { role: "alert" as const } : {})} style={{
      display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      background: danger ? color.dangerTint : color.warnTint,
      border: `1px solid ${danger ? color.danger : color.warn}`, borderRadius: 8,
      padding: danger ? "10px 12px 10px 14px" : "8px 12px 8px 14px",
    }}>
      <span aria-hidden style={{ display: "inline-flex", color: danger ? color.danger : color.warnInk, flex: "none" }}>{icon}</span>
      <span style={{ fontSize: 13.5, color: color.ink, minWidth: 0, flex: "1 1 240px", display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        {lead && <b>{lead}</b>}
        {children}
      </span>
      {actions && <span style={{ display: "inline-flex", gap: 8, marginLeft: "auto", flex: "none" }}>{actions}</span>}
    </div>
  );
};

const NODE_TYPE: Record<string, { label: string; bg: string; fg: string }> = {
  RootTable: { label: "ROOT", bg: color.brandTint, fg: color.brandInk },
  LookupTable: { label: "LOOKS UP", bg: color.fill, fg: color.inkMuted },
  ChildTable: { label: "HAS MANY", bg: color.validationTint, fg: color.validation },
};

/** ROOT / LOOKS UP / HAS MANY, for data-model trees. `fixed` gives every tag the same width. */
export const NodeTypeTag: React.FC<{ type: string | null; fixed?: boolean }> = ({ type, fixed }) => {
  const t = NODE_TYPE[type ?? "RootTable"] ?? NODE_TYPE.RootTable;
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, letterSpacing: ".05em", padding: "1px 6px", borderRadius: 4,
      background: t.bg, color: t.fg, whiteSpace: "nowrap", flex: "none",
      ...(fixed ? { width: 74, textAlign: "center", boxSizing: "border-box", display: "inline-block" } : {}),
    }}>
      {t.label}
    </span>
  );
};

export interface RadioCardOption { value: string; title: React.ReactNode; sub?: React.ReactNode }

/**
 * Single choice as bordered cards (title + optional muted subline). The selected card gets a
 * brand border on the brand tint. Used by Show as, and by New rule's Data model.
 */
export function RadioCards({ ariaLabel, value, options, onChange, ariaLabelledBy }: {
  ariaLabel?: string; ariaLabelledBy?: string; value: string | null; options: RadioCardOption[]; onChange(v: string): void;
}) {
  return (
    <RadioGroup aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} value={value ?? ""}
      onChange={(_e, d) => onChange(d.value)} style={{ gap: 8, alignItems: "stretch" }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <div key={o.value} style={{
            border: `1px solid ${on ? color.brand : tokens.colorNeutralStroke1}`, borderRadius: 6,
            background: on ? color.brandTint : color.surface, padding: "2px 4px", width: "100%", boxSizing: "border-box",
          }}>
            <Radio value={o.value} label={{
              children: (
                <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
                  <span style={{ fontSize: 13.5, color: color.ink }}>{o.title}</span>
                  {o.sub && <span style={{ fontSize: 12, color: color.inkMuted }}>{o.sub}</span>}
                </span>
              ),
            }} />
          </div>
        );
      })}
    </RadioGroup>
  );
}
