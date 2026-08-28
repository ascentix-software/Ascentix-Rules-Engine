import { devOrg } from "../devOrg";
import { ENTITY_SET } from "../../src/editor/load/odata";

// Settle oracle (CONTEXT.md "Settle"): waiting for the platform to agree with the state a test
// just established. Every wait in the live harness is a PROBE polled to a cap, never a sleep:
// a dead rule or a genuinely wrong verdict still fails, at the cap, with a message that says so.
//
// Two lags, two named probes:
//   enforcement settle: the publish transaction writes the enforcement step row, but the
//     plugin pipeline metadata cache propagates asynchronously across front-end nodes; only a
//     sacrificial violating operation proves the step runs (enforcementSettled).
//   data settle: the engine's traversal is a RetrieveMultiple against the org the test just
//     wrote to, and Dataverse does not promise read-after-write visibility; asx_RunRules is the
//     engine's own read-only verdict over the identical path, so it is the honest oracle
//     (dataVisible). configsVisible is the same lag on the asx_tableconfig tree itself.

export interface SettleContext {
  label: string;
  capMs: number;
  intervalMs: number;
  elapsedMs: number;
  attempts: number;
}

export interface SettleOptions {
  label: string;
  capMs?: number; // default 30000
  intervalMs?: number; // default 1000
  // Appended to the timeout error (e.g. the per-node rows asx_RunRules saw). Best-effort: a
  // diagnostic failure never replaces the timeout it is explaining.
  diagnostic?: () => Promise<string> | string;
  // The timeout text; default `${label}: not settled within ${capMs}ms`.
  timeoutMessage?: (ctx: SettleContext) => string;
}

// Poll `probe` until it resolves true. A probe that throws propagates immediately (the caller's
// own assertions run inside probes). Past the cap: throw an Error carrying the label (or the
// caller's timeout text) plus the diagnostic.
export async function settle(probe: () => Promise<boolean>, opts: SettleOptions): Promise<void> {
  const capMs = opts.capMs ?? 30000;
  const intervalMs = opts.intervalMs ?? 1000;
  const start = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    if (await probe()) return;
    const elapsedMs = Date.now() - start;
    if (elapsedMs > capMs) {
      const ctx: SettleContext = { label: opts.label, capMs, intervalMs, elapsedMs, attempts };
      const base = opts.timeoutMessage ? opts.timeoutMessage(ctx) : `${opts.label}: not settled within ${capMs}ms`;
      throw new Error(base + (await diagnosticText(opts.diagnostic)));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function diagnosticText(diagnostic: SettleOptions["diagnostic"]): Promise<string> {
  if (!diagnostic) return "";
  try {
    return ` ${await diagnostic()}`;
  } catch (e: any) {
    return ` (diagnostic unavailable: ${e?.message})`;
  }
}

// ── Enforcement settle ───────────────────────────────────────────────────────
//
// A step-existence poll proves nothing (the row exists immediately; the cache is what lags) and
// a fixed delay guesses, so the only honest settle is behavioral: repeat a sacrificial violating
// probe until the block (or the write action) is observed. Observed live: an OnDelete Block
// flake; an operator-matrix Equals flake; a cold Tier-C org's first publish.
export async function enforcementSettled(
  probe: () => Promise<boolean>, // true = enforcement observed
  opts: { label?: string; intervalMs?: number; capMs?: number } = {},
): Promise<void> {
  await settle(probe, {
    label: opts.label ?? "enforcement",
    intervalMs: opts.intervalMs ?? 1000,
    capMs: opts.capMs ?? 30000,
    timeoutMessage: ({ capMs }) =>
      `awaitEnforcement: enforcement not observed within ${capMs}ms` +
      (opts.label ? ` (${opts.label})` : "") +
      " — step cache never settled or the rule is dead",
  });
}

// ── Data settle ──────────────────────────────────────────────────────────────
//
// Poll asx_RunRules (with the pending update's values overlaid) until the engine's read-only
// verdict agrees the rule fires / does not fire; then the caller asserts the real enforcement.
// On timeout the error carries the per-node row counts the traversal actually saw: an empty
// collection is the difference between "the rule is wrong" and "the engine never saw the rows".
export async function dataVisible(
  tableName: string,
  recordId: string,
  opts: { expectMessage: string; expectFired: boolean; triggers?: string; capMs?: number; recordJson?: string },
): Promise<void> {
  const triggers = opts.triggers ?? "4";
  let fired = false;
  await settle(
    async () => {
      const verdict = await devOrg("user").runRules(tableName, { recordId, recordJson: opts.recordJson, triggers });
      fired = verdict.firedActions.some((a: any) => String(a.Message ?? a.message ?? "").includes(opts.expectMessage));
      return fired === opts.expectFired;
    },
    {
      label: `awaitEngineVerdict ${tableName}(${recordId})`,
      capMs: opts.capMs ?? 30000,
      timeoutMessage: ({ capMs }) =>
        `awaitEngineVerdict: after ${capMs}ms the engine still ${fired ? "fires" : "does not fire"} ` +
        `"${opts.expectMessage}" for ${tableName}(${recordId}), expected ` +
        `${opts.expectFired ? "fired" : "not fired"}.`,
      diagnostic: async () => `Traversal saw: ${await traversalDiagnostics(tableName, recordId, triggers, opts.recordJson)}`,
    },
  );
}

// One asx_RunRules call with IncludeDiagnostics, rendered as "table:rows" per traversed node.
// Best-effort: a diagnostics failure must never replace the assertion failure it is explaining.
export async function traversalDiagnostics(
  tableName: string,
  recordId: string,
  triggers: string,
  recordJson?: string,
): Promise<string> {
  try {
    const { diagnostics } = await devOrg("user").runRules(tableName, { recordId, recordJson, triggers, includeDiagnostics: true });
    if (!diagnostics) return "(no diagnostics returned)";
    const nodes = (diagnostics.nodes ?? []).map((n) => `${n.table ?? n.nodeId}:${n.rows}`);
    return nodes.length ? nodes.join(", ") : "(no traversal nodes fetched)";
  } catch (e: any) {
    return `(diagnostics unavailable: ${e?.message})`;
  }
}

// ── Config-tree settle ───────────────────────────────────────────────────────
//
// A freshly created asx_tableconfig row is not immediately visible to the engine's id-filtered
// RetrieveMultiple over that table. The engine fails closed on a node that does not load
// (Core/Loaders/TableConfigLoader.cs), so a rule authored against a not-yet-visible tree errors
// instead of silently evaluating an empty collection, but a test must not race it at all. Poll
// the same way the engine reads (filter by id, not a point retrieve) until every node answers.
export async function configsVisible(ids: string[], capMs = 60000): Promise<void> {
  const api = devOrg("user").api;
  let seen = 0;
  await settle(
    async () => {
      const filter = ids.map((id) => `asx_tableconfigid eq ${id}`).join(" or ");
      const r = await api.retrieveMultipleRecords(ENTITY_SET.tableConfig, `?$filter=${filter}&$select=asx_tableconfigid`);
      seen = r.entities.length;
      return seen >= ids.length;
    },
    {
      label: "awaitConfigsVisible",
      capMs,
      intervalMs: 500,
      timeoutMessage: () =>
        `awaitConfigsVisible: only ${seen}/${ids.length} table-config nodes became ` +
        `visible within ${capMs}ms — the org never made the freshly created tree readable.`,
    },
  );
}
