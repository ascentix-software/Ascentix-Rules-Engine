// Runs `fn` over `items` with at most `limit` calls in flight, and resolves once every call
// settles. A rejection rejects the whole run after the others settle. Use it only for calls that
// don't depend on each other: deleting plain data rows, not rules (asx_DeleteRule reconciles
// plug-in steps across every rule, so rule deletes stay serial).
// Dataverse allows 52 concurrent requests per user; 8 stays well clear of throttling.
export async function forEachLimit<T>(items: readonly T[], fn: (item: T) => Promise<void>, limit = 8): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch (err) { errors.push(err); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length) throw errors[0];
}
