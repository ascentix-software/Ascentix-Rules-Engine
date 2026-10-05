import { type DataUpdateStatus, type WebApiPort } from "../webapi";

// asx_ApplyDataUpdates fails a call whose update hit a failing item with
// "asx_ApplyDataUpdates:item-failed:<token>:<message>" (docs/Schema.md §10), where the token is
// "<update number>/<item>". The token is opaque here: it is sent back exactly as received. Dataverse
// may wrap the message, so the marker is searched anywhere. Tokens never contain ':' or whitespace.
const FAILURE = /asx_ApplyDataUpdates:item-failed:([^:\s]+):([\s\S]*)$/;

/** `item` is the failed-item token, to send back as FailedItem unchanged. */
export function parseItemFailure(message: string): { item: string; message: string } | null {
  const m = FAILURE.exec(message.trim());
  return m ? { item: m[1], message: m[2] } : null;
}

/**
 * Calls Apply until nothing is pending. After an item-failed error the next call reports that item
 * (and nothing else is processed by it). A retry is re-sent until a call succeeds, because a failed
 * call rolls its reset back. If the item just reported fails again before any other call succeeds,
 * the update isn't skipping it, so this stops instead of looping.
 */
export async function driveDataUpdates(
  api: Pick<WebApiPort, "applyDataUpdates">,
  retry: number | undefined,
  onProgress: (s: DataUpdateStatus) => void,
  signal: AbortSignal,
): Promise<DataUpdateStatus | undefined> {
  if (!api.applyDataUpdates) throw new Error("This environment can't apply data updates.");
  let failed: { item: string; message: string } | undefined;
  // The last token reported, until a call that reports nothing succeeds.
  let reported: string | undefined;
  let pendingRetry = retry;
  let last: DataUpdateStatus | undefined;
  while (!signal.aborted) {
    try {
      last = await api.applyDataUpdates("Apply", {
        ...(pendingRetry !== undefined ? { retry: pendingRetry } : {}),
        ...(failed ? { failed } : {}),
      });
      reported = failed?.item;
      failed = undefined;
      pendingRetry = undefined;
    } catch (e) {
      const parsed = parseItemFailure(e instanceof Error ? e.message : String(e));
      if (!parsed) throw e;
      if (parsed.item === reported) throw new Error(`Data update item ${parsed.item} keeps failing: ${parsed.message}`);
      failed = parsed;
      continue;
    }
    onProgress(last);
    if (last.done) break;
  }
  return last;
}
