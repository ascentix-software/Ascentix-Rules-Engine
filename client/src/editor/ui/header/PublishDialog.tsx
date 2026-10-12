import * as React from "react";
import { Button, Link } from "@fluentui/react-components";
import {
  CheckmarkCircle16Regular, Warning16Regular, DocumentSearch16Regular, ErrorCircle16Regular,
} from "@fluentui/react-icons";
import { DialogShell } from "../DialogShell";
import { InfoTip } from "../primitives";
import { color } from "../tokens";
import type { Issue } from "../useIssues";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const Row: React.FC<{ icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode; first?: boolean }> = ({
  icon, children, action, first,
}) => (
  <div style={{
    display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", fontSize: 13.5, color: color.ink,
    borderTop: first ? undefined : `1px solid ${color.line}`,
  }}>
    <span aria-hidden style={{ display: "inline-flex", flex: "none" }}>{icon}</span>
    <span style={{ minWidth: 0, flex: 1 }}>{children}</span>
    {action && <span style={{ flex: "none" }}>{action}</span>}
  </div>
);

const List: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ border: `1px solid ${color.line}`, borderRadius: 8 }}>{children}</div>
);

/**
 * Publish…: shown after the save + server check. Ready (no errors; warnings
 * allowed) confirms the publish; Blocked lists the errors to fix.
 */
export function PublishDialog({
  open, ruleName, version, errors, warnings, changeCount, modelName, busy,
  onCancel, onConfirm, onViewWarnings, onReviewChanges, onGoTo, onOpenIssues,
}: {
  open: boolean;
  ruleName: string;
  /** The live version number; 0 when never published. */
  version: number;
  errors: Issue[];
  warnings: Issue[];
  /** Changes since the live version; null when unknown. */
  changeCount: number | null;
  modelName: string | null;
  busy?: boolean;
  onCancel(): void;
  onConfirm(): void;
  onViewWarnings(): void;
  onReviewChanges(): void;
  onGoTo(issue: Issue): void;
  onOpenIssues(): void;
}) {
  const next = version + 1;
  if (errors.length > 0) {
    return (
      <DialogShell open={open} onClose={onCancel} width={560}
        title={`Fix ${plural(errors.length, "error")} to publish`}
        actions={<>
          <Button appearance="secondary" onClick={onCancel}>Close</Button>
          <Button appearance="primary" onClick={onOpenIssues}>Open issues</Button>
        </>}>
        <List>
          {errors.map((e, i) => (
            <Row key={e.id} first={i === 0} icon={<ErrorCircle16Regular style={{ color: color.danger }} />}
              action={<Link as="button" onClick={() => onGoTo(e)}>Go to field</Link>}>
              <div style={{ fontWeight: 600 }}>{e.path}</div>
              <div style={{ fontSize: 12.5, color: color.inkMuted }}>{e.message}</div>
            </Row>
          ))}
          {warnings.length > 0 && (
            <Row icon={<Warning16Regular style={{ color: color.warnInk }} />}
              action={<Link as="button" onClick={onViewWarnings}>View all</Link>}>
              {plural(warnings.length, "warning")}
            </Row>
          )}
        </List>
      </DialogShell>
    );
  }
  return (
    <DialogShell open={open} onClose={onCancel} width={560}
      title={`Publish v${next}?`}
      actions={<>
        <Button appearance="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button appearance="primary" disabled={busy} onClick={onConfirm}>Publish v{next}</Button>
      </>}>
      <p style={{ margin: 0, fontSize: 13.5 }}>
        {version > 0
          ? <>v{next} replaces v{version} for new evaluations of <b>{ruleName}</b>.</>
          : <><b>{ruleName}</b> will start running for new evaluations.</>}
      </p>
      <List>
        <Row first icon={<CheckmarkCircle16Regular style={{ color: color.success }} />}>No errors</Row>
        {warnings.length > 0 && (
          <Row icon={<Warning16Regular style={{ color: color.warnInk }} />}
            action={<Link as="button" onClick={onViewWarnings}>View</Link>}>
            {plural(warnings.length, "warning")}: {warnings[0].message}
          </Row>
        )}
        {version > 0 && changeCount != null && (
          <Row icon={<DocumentSearch16Regular style={{ color: color.brandInk }} />}
            action={<Link as="button" onClick={onReviewChanges}>Review</Link>}>
            {plural(changeCount, "change")} since v{version}
          </Row>
        )}
      </List>
      {modelName && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, color: color.inkMuted }}>
          Includes this rule's copy of the shared data model
          <InfoTip label="Shared data model"
            text={`Shared data-model changes take effect for each rule only when that rule is republished. Other rules using ${modelName} keep their own published copy.`} />
        </span>
      )}
    </DialogShell>
  );
}
