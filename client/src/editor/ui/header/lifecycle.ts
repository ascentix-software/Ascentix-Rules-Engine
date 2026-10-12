import type { RuleGraph } from "../../model/types";
import { diffRuleGraph } from "../../save/diff";

/**
 * Where the rule is in its publish lifecycle, as the header shows it. `live` is
 * false for a rule that was published once and then unpublished: it still has a
 * published revision (so a draft is opened to edit it) but nothing is enforced.
 */
export type Lifecycle =
  | { kind: "liveReadOnly"; version: number; live: boolean }
  | { kind: "viewingPublished"; version: number; dirtyCount: number }
  | { kind: "draftOfLive"; version: number; dirtyCount: number; saved: boolean; live: boolean }
  | { kind: "newDraft"; dirtyCount: number }
  | { kind: "archived" };

export const PUBLISHED = 753840000;
export const ARCHIVED = 2;

/**
 * The number of changed entities (the rows ReviewChangesDialog lists), plus one
 * for pending schedule ops. Zero whenever the graph is unchanged: the diff can
 * carry normalising writes (a stale stored default) that aren't edits.
 */
export function dirtyCount(snapshot: RuleGraph, working: RuleGraph, scheduleOpCount: number): number {
  const schedule = scheduleOpCount > 0 ? 1 : 0;
  if (JSON.stringify(snapshot) === JSON.stringify(working)) return schedule;
  const rows = new Set(diffRuleGraph(snapshot, working).map((op) =>
    `${op.entity}:${op.kind === "create" ? op.tempId : op.id}`));
  return Math.max(1, rows.size) + schedule;
}

export function deriveLifecycle(args: {
  serverStatus: number | null;
  rule: RuleGraph["rule"];
  needsDraft: boolean;
  viewingPublished: boolean;
  dirtyCount: number;
}): Lifecycle {
  const { serverStatus, rule, needsDraft, viewingPublished, dirtyCount: n } = args;
  const version = rule.publishedVersion ?? 0;
  if (serverStatus === ARCHIVED) return { kind: "archived" };
  if (viewingPublished) return { kind: "viewingPublished", version, dirtyCount: n };
  const live = serverStatus === PUBLISHED;
  if (needsDraft) return { kind: "liveReadOnly", version, live };
  const hasRevision = live || !!rule.publishedRevisionId;
  if (hasRevision) return { kind: "draftOfLive", version, dirtyCount: n, saved: n === 0, live };
  return { kind: "newDraft", dirtyCount: n };
}

/** "1 unsaved change" / "4 unsaved changes". */
export function unsavedText(n: number): string {
  return `${n} unsaved change${n === 1 ? "" : "s"}`;
}

/** True when an On demand run can be applied: the rule is live and its PUBLISHED triggers include On demand (3). */
export function canApply(isLive: boolean, publishedTriggers: number[]): boolean {
  return isLive && publishedTriggers.includes(3);
}

/**
 * What differs between the live version and the draft, one label per changed
 * entity. The draft's rows have their own ids, so entities are matched by
 * position (group path, condition index, action order) and compared with ids
 * replaced by the names they point at.
 */
export function changesSince(published: RuleGraph, draft: RuleGraph): string[] {
  const entries = (g: RuleGraph): Map<string, { label: string; sig: string }> => {
    const names = new Map<string, string>();
    for (const n of Object.values(g.tableConfigs)) names.set(n.id, `node:${n.name}`);
    for (const o of g.validationGroups) names.set(o.id, `outcome:${o.name}`);
    const sig = (v: unknown): string => JSON.stringify(v, (k, x) => {
      if (k === "id" || k === "etag" || k === "parentGroupId" || k === "conditions" || k === "groups") return undefined;
      if (typeof x === "string" && names.has(x)) return names.get(x);
      return x;
    });
    const out = new Map<string, { label: string; sig: string }>();
    const { id: _id, etag: _e, activeRuleId: _a, activeEtag: _ae, statusCode: _s, publishedRevisionId: _p,
      publishedVersion: _v, rootTableConfigId: _r, ...rule } = g.rule as RuleGraph["rule"] & Record<string, unknown>;
    out.set("rule", { label: "Rule settings", sig: sig(rule) });
    const walk = (gs: RuleGraph["executionGroups"], path: string, zone: string) => gs.forEach((grp, i) => {
      const p = `${path}/${i}`;
      out.set(`g${p}`, { label: `${zone} group ${grp.name}`, sig: sig(grp) });
      grp.conditions.forEach((c, j) => out.set(`c${p}/${j}`, { label: `Condition in ${grp.name}`, sig: sig(c) }));
      walk(grp.groups, p, zone);
    });
    walk(g.executionGroups, "e", "Only if");
    walk(g.validationGroups, "v", "Outcome");
    g.actions.forEach((a, i) => out.set(`a${i}`, { label: `Action ${i + 1}`, sig: sig(a) }));
    Object.values(g.tableConfigs).forEach((n) => out.set(`n:${n.tableLogicalName}:${n.name}`, {
      label: `Data model ${n.name}`, sig: sig({ ...n, parentTableConfigId: null }),
    }));
    return out;
  };
  const before = entries(published);
  const after = entries(draft);
  const changed: string[] = [];
  for (const [k, v] of after) if (before.get(k)?.sig !== v.sig) changed.push(v.label);
  for (const [k, v] of before) if (!after.has(k)) changed.push(`${v.label} (removed)`);
  return changed;
}
