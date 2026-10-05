import * as React from "react";
import type { DataUpdateStatus, WebApiPort } from "../webapi";

export interface DataUpdateGate {
  /** The last Status result, or null before it loads, when it fails, or when the API is missing. */
  status: DataUpdateStatus | null;
  /** True while a data update is pending: views hide their edit controls (docs/Schema.md §10). */
  readOnly: boolean;
  reload(): void;
}

const NONE: DataUpdateGate = { status: null, readOnly: false, reload: () => {} };
const Ctx = React.createContext<DataUpdateGate>(NONE);

/** Outside a provider (most unit tests) nothing is pending. */
export function useDataUpdates(): DataUpdateGate {
  return React.useContext(Ctx);
}

/**
 * Loads asx_ApplyDataUpdates Status once per view (and on reload). A failed or missing Status leaves
 * the view editable; the server's publish gate still refuses publishing while an update is pending.
 */
export function DataUpdateProvider({ api, children }: { api: Pick<WebApiPort, "applyDataUpdates">; children: React.ReactNode }) {
  const [status, setStatus] = React.useState<DataUpdateStatus | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!api.applyDataUpdates) return;
    let live = true;
    api.applyDataUpdates("Status")
      .then((s) => { if (live) setStatus(s); })
      .catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, [api, tick]);
  const value = React.useMemo<DataUpdateGate>(() => ({
    status,
    readOnly: !!status && status.pending.length > 0,
    reload: () => setTick((t) => t + 1),
  }), [status]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
