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
