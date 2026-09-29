// The asx_RunRules outputs the Rule Builder's Test dialog reads (docs/Schema.md §3).
// A create's targetId is always null: the engine never reports the id it assigns internally.
export interface DryRunWrite { operation: string; targetTable: string | null; targetId: string | null; values?: Record<string, unknown>; }
export interface DryRunAction {
  ruleId: string; actionType: string; fireOn: string; message: string | null; targetTable: string | null;
  write?: DryRunWrite; writes?: DryRunWrite[]; writeCount?: number; unchangedCount?: number; previousOf?: string;
}
export interface ChangeSetSummary { creates: number; updates: number; deletes: number; unchanged: number; }
export interface DryRunResult { isValid: boolean; actions: DryRunAction[]; changeSet: ChangeSetSummary | null; }

const TRIGGER_NAMES: Record<number, string> = { 1: "OnCreate", 2: "OnForm", 3: "OnDemand", 4: "OnUpdate", 5: "OnDelete" };
/** asx_rule trigger value → the name asx_RunRules' Triggers parameter takes. */
export function triggerName(v: number): string { return TRIGGER_NAMES[v] ?? "OnDemand"; }

function verbOf(actionType: string, operation?: string): string {
  if (actionType === "DeactivateRecord") return "Deactivate";
  return operation ?? actionType.replace(/Record$/, "");
}

export function describeWrite(w: DryRunWrite): string {
  return `${w.operation} ${w.targetTable ?? "?"}${w.targetId ? ` ${w.targetId}` : ""}`;
}

/** "Update contact × 12 (3 unchanged)" for a set action; "Create task" for a single write. */
export function describeFiredAction(a: DryRunAction): string {
  if (a.writes) {
    const first = a.writes[0];
    const table = first?.targetTable ?? a.targetTable;
    const unchanged = a.unchangedCount ? ` (${a.unchangedCount} unchanged)` : "";
    return `${verbOf(a.actionType, first?.operation)}${table ? ` ${table}` : ""} × ${a.writeCount ?? a.writes.length}${unchanged}`;
  }
  if (a.write) return `${verbOf(a.actionType, a.write.operation)} ${a.write.targetTable ?? "?"}`;
  if (a.message) return `${a.actionType}: ${a.message}`;
  return a.actionType;
}

export function summarizeChangeSet(cs: ChangeSetSummary): string {
  const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  return `Change set: ${n(cs.creates, "create")}, ${n(cs.updates, "update")}, ${n(cs.deletes, "delete")} · ${cs.unchanged} unchanged`;
}

export function parseDryRun(raw: { IsValid?: boolean; Results?: string; ChangeSet?: string } | null | undefined): DryRunResult {
  if (raw == null || raw.Results == null) throw new Error("asx_RunRules returned no Results payload");
  return {
    isValid: raw.IsValid ?? true,
    actions: JSON.parse(raw.Results) as DryRunAction[],
    changeSet: raw.ChangeSet ? (JSON.parse(raw.ChangeSet) as ChangeSetSummary) : null,
  };
}
