import type { RuleDef } from "./contract";

export type Classification = "RootOnly" | "NeedsExternal";

// Plan 4B-1 STUB: every rule is delegated to asx_RunRules. The real §6 predicate
// (root-only vs needs-external) and the in-browser evaluator are Plan 4B-2; this
// function is the single swap point. Nothing else changes when 4B-2 lands.
export function classify(_rule: RuleDef): Classification {
  return "NeedsExternal";
}
