import type { FiresWhenGroup, FiresWhenTest } from "./types";
import { newTempId } from "./ids";

/** "Always, when the rule runs": a root ALL group with no children. */
export function always(): FiresWhenGroup { return emptyGroup("all"); }
export function emptyGroup(op: "all" | "any" = "all"): FiresWhenGroup { return { id: newTempId(), op, tests: [], groups: [] }; }
export function emptyTest(outcomeId: string | null): FiresWhenTest { return { id: newTempId(), outcomeId, expected: true }; }

export function isAlways(g: FiresWhenGroup | null): boolean {
  return !!g && g.op === "all" && g.tests.length === 0 && g.groups.length === 0;
}

export function outcomeIdsUsed(g: FiresWhenGroup | null, into = new Set<string>()): Set<string> {
  if (!g) return into;
  for (const t of g.tests) if (t.outcomeId) into.add(t.outcomeId);
  for (const c of g.groups) outcomeIdsUsed(c, into);
  return into;
}

/** The same tree without the tests of one outcome (used when that outcome is deleted). */
export function removeOutcomeTests(g: FiresWhenGroup, outcomeId: string): FiresWhenGroup {
  return {
    ...g,
    tests: g.tests.filter((t) => t.outcomeId !== outcomeId),
    groups: g.groups.map((c) => removeOutcomeTests(c, outcomeId)),
  };
}

/**
 * An action's tree once one outcome is deleted: that outcome's tests are gone, and a tree that had
 * content but is left empty becomes not set (null). Left as an empty root it would read "Always" and
 * fire every time the rule runs; not set never fires and publish refuses it until the author picks again.
 */
export function firesWhenAfterOutcomeDelete(g: FiresWhenGroup | null, outcomeId: string): FiresWhenGroup | null {
  if (!g) return g;
  const after = removeOutcomeTests(g, outcomeId);
  const hadContent = g.tests.length > 0 || g.groups.length > 0;
  const nowEmpty = after.tests.length === 0 && after.groups.length === 0;
  return hadContent && nowEmpty ? null : after;
}
