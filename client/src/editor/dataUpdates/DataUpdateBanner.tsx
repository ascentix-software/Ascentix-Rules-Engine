import * as React from "react";
import {
  Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Spinner,
} from "@fluentui/react-components";
import { Callout, NoticeBar, InfoTip } from "../ui/primitives";
import { Warning20Regular } from "@fluentui/react-icons";
import { formatError } from "../ui/errors";
import { DATA_UPDATE_STATUS, type DataUpdateRef, type DataUpdateStatus, type WebApiPort } from "../webapi";
import { useDataUpdates } from "./DataUpdateContext";
import { driveDataUpdates } from "./applyDriver";

export const pendingText = (u: DataUpdateRef) => `Update ${u.number} · ${u.title} must be applied before rules can be edited.`;
export const NOT_ADMIN_NOTE =
  "Ask a System Administrator or System Customizer to apply it. Until then, rules can be viewed but not edited.";

type Api = Pick<WebApiPort, "applyDataUpdates">;

function reloadWindow() {
  try {
    window.location.reload();
  } catch {
    // hosts without navigation: the status reload below the dialog still runs
  }
}

/**
 * The pending-update banner (or, for administrators, the completed-with-failures notice). After an
 * apply that finished, closing its dialog reloads the page, so no view keeps a graph loaded before the
 * update converted it; after an error it reloads only the status.
 */
export function DataUpdateBanner({ api, reloadPage = reloadWindow }: { api: Api; reloadPage?: () => void }) {
  const { status, reload } = useDataUpdates();
  const [confirming, setConfirming] = React.useState(false);
  const [applying, setApplying] = React.useState<{ retry?: number } | null>(null);
  const [dismissed, setDismissed] = React.useState(false);
  if (!status) return null;

  const dialogs = (
    <>
      <ConfirmApplyDialog open={confirming} update={status.pending[0]}
        onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); setApplying({}); }} />
      {applying && (
        <ApplyDataUpdatesDialog api={api} retry={applying.retry}
          onClose={(finished) => {
            setApplying(null);
            setDismissed(false);
            if (finished) reloadPage();
            else reload();
          }} />
      )}
    </>
  );

  const next = status.pending[0];
  if (next) {
    return (
      <div data-testid="data-update-banner">
        <NoticeBar tone="warn" icon={<Warning20Regular />} lead={`Read-only until Update ${next.number} is applied.`}
          actions={status.canApply
            ? <Button appearance="primary" size="small" onClick={() => setConfirming(true)}>Apply now</Button>
            : undefined}>
          {next.title}
          <InfoTip label="Data update" text={NOT_ADMIN_NOTE} />
        </NoticeBar>
        {dialogs}
      </div>
    );
  }

  const latest = status.latest;
  if (latest && latest.status === DATA_UPDATE_STATUS.CompletedWithFailures && status.canApply && !dismissed) {
    return (
      <div data-testid="data-update-failures">
        <NoticeBar tone="warn" icon={<Warning20Regular />}
          lead={`Update ${latest.number} · ${latest.title} finished with ${latest.failed} failed item(s).`}
          actions={<>
            <Button size="small" onClick={() => setApplying({ retry: latest.number })}>Retry failed items</Button>
            <Button size="small" appearance="subtle" onClick={() => setDismissed(true)}>Dismiss</Button>
          </>}>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, width: "100%" }}>
            {latest.failures.map((f) => <li key={f.item}><code>{f.item}</code>: {f.message}</li>)}
          </ul>
        </NoticeBar>
        {dialogs}
      </div>
    );
  }
  return null;
}

function ConfirmApplyDialog({ open, update, onCancel, onConfirm }: {
  open: boolean; update: DataUpdateRef | undefined; onCancel(): void; onConfirm(): void;
}) {
  return (
    <Dialog open={open && !!update} onOpenChange={(_e, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Apply update {update?.number}?</DialogTitle>
          <DialogContent>
            {update?.title}. This converts existing rules for this release. It can take a few minutes; keep this tab
            open until it finishes.
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" onClick={onConfirm}>Apply</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** `onClose(finished)`: finished is true when the run ended without an error. */
function ApplyDataUpdatesDialog({ api, retry, onClose }: { api: Api; retry?: number; onClose(finished: boolean): void }) {
  const [progress, setProgress] = React.useState<DataUpdateStatus | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [running, setRunning] = React.useState(true);
  React.useEffect(() => {
    const controller = new AbortController();
    let live = true;
    driveDataUpdates(api, retry, (s) => { if (live) setProgress(s); }, controller.signal)
      .catch((e) => { if (live) setError(e); })
      .finally(() => { if (live) setRunning(false); });
    return () => { live = false; controller.abort(); };
  }, [api, retry]);

  const latest = progress?.latest;
  return (
    <Dialog open onOpenChange={(_e, d) => { if (!d.open && !running) onClose(!error); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Applying data updates</DialogTitle>
          <DialogContent>
            {running && (
              <Spinner label={latest
                ? `Update ${latest.number}: ${latest.succeeded} converted, ${latest.failed} failed. Keep this tab open.`
                : "Starting… keep this tab open."} />
            )}
            {!running && !!error && <Callout intent="danger">{formatError(error)}</Callout>}
            {!running && !error && latest && (
              <Callout intent={latest.failed > 0 ? "warning" : "success"}>
                Update {latest.number} · {latest.title}: {latest.succeeded} converted, {latest.failed} failed.
              </Callout>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={running} onClick={() => onClose(!error)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
