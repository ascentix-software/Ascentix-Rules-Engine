import { eventually } from "./settle";

// Fixture cleanup for the live suites. A published ZZ_RB_ rule that survives its test keeps
// enforcing on every later save of its table, so a cleanup failure must never be dropped:
// `drainCleanups` retries each cleanup, keeps the ones that still fail in the list for the next
// drain (afterEach of the retried attempt, then afterAll), and throws so the failure is visible.
// The per-test cleanups that authorRule returns are idempotent and retain their work on failure
// (authoring.ts deleteInReverse), so running one again is always safe.

export type Cleanup = () => Promise<void>;

// Cleanups that failed outside any test's list (authorRule's own drain after a mid-author
// failure). Every drainCleanups call also drains these.
const orphaned: Cleanup[] = [];

export function queueOrphanedCleanup(cleanup: Cleanup): void {
  orphaned.push(cleanup);
}

// Runs `cleanups` last-in first-out. Each one gets `timeoutMs` of retries; those still failing are
// put back (in their original order) and reported together in one thrown Error.
export async function drainCleanups(cleanups: Cleanup[], opts: { timeoutMs?: number } = {}): Promise<void> {
  const failed: { cleanup: Cleanup; error: unknown }[] = [];
  for (const list of [cleanups, orphaned]) {
    while (list.length) {
      const cleanup = list.pop()!;
      try {
        await eventually(cleanup, { label: "cleanup", timeoutMs: opts.timeoutMs ?? 30000, intervalMs: 2000 });
      } catch (error) {
        failed.unshift({ cleanup, error });
      }
    }
  }
  if (!failed.length) return;
  cleanups.push(...failed.map(f => f.cleanup));
  const messages = failed.map(f => (f.error instanceof Error ? f.error.message : String(f.error)));
  throw new Error(`${failed.length} fixture cleanup(s) failed and are queued for the next drain:\n${messages.join("\n")}`);
}
