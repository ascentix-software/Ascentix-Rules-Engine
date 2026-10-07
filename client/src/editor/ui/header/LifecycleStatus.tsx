import * as React from "react";
import { Pill, InfoTip } from "../primitives";
import { color } from "../tokens";
import { type Lifecycle, unsavedText } from "./lifecycle";

const Dot: React.FC = () => (
  <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: color.success, display: "inline-block" }} />
);

const Trailing: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontSize: 12.5, color: color.inkMuted, display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}>
    {children}
  </span>
);

export function formatPublished(on: string | null | undefined, by: string | null | undefined): string | null {
  if (!on) return null;
  const d = new Date(on);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return by ? `Published ${date} by ${by}` : `Published ${date}`;
}

/** The pills + trailing text under the rule name: where this rule is in its lifecycle. */
export function LifecycleStatus({ lifecycle, publishedText }: {
  lifecycle: Lifecycle;
  /** "Published 2 Oct by Dana", when the revision row is loaded. */
  publishedText?: string | null;
}) {
  const l = lifecycle;
  const livePill = (version: number, live: boolean) => live
    ? <Pill tone="published"><Dot />Live · v{version}</Pill>
    : <Pill tone="neutral">Not live · v{version}</Pill>;
  let pills: React.ReactNode;
  let trailing: React.ReactNode = null;
  switch (l.kind) {
    case "liveReadOnly":
      pills = livePill(l.version, l.live);
      trailing = (
        <Trailing>
          {publishedText}
          <InfoTip label="Live version"
            text={`This is the version being enforced. Edit rule opens a separate draft; v${l.version} keeps enforcing until you publish.`} />
        </Trailing>
      );
      break;
    case "draftOfLive":
      pills = <>{livePill(l.version, l.live)}<Pill tone="warn">Editing draft</Pill></>;
      trailing = <Trailing>{l.dirtyCount > 0 ? unsavedText(l.dirtyCount) : `Draft differs from v${l.version}`}</Trailing>;
      break;
    case "newDraft":
      pills = <><Pill tone="neutral">Not live</Pill><Pill tone="warn">Draft</Pill></>;
      trailing = l.dirtyCount > 0 ? <Trailing>{unsavedText(l.dirtyCount)}</Trailing> : null;
      break;
    case "viewingPublished":
      pills = <Pill tone="published"><Dot />Viewing live v{l.version}</Pill>;
      trailing = (
        <Trailing>
          {l.dirtyCount > 0 ? `Read-only · Your draft has ${unsavedText(l.dirtyCount)}` : "Read-only"}
        </Trailing>
      );
      break;
    case "archived":
      pills = <Pill tone="archived">Archived</Pill>;
      break;
  }
  return (
    <div data-testid="lifecycle-status" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
      {pills}
      {trailing}
    </div>
  );
}
