import type { XrmAdapter, RequiredLevel, NotificationLevel } from "./xrm";
import type { FiredAction } from "./contract";

export interface Baseline {
  visible: Record<string, boolean>;
  required: Record<string, RequiredLevel>;
}

// Snapshot the load-time visibility + required level of every control a rule
// could govern (the action universe). Each apply cycle resets to this.
export function snapshotBaseline(xrm: XrmAdapter, universeControls: string[]): Baseline {
  const visible: Record<string, boolean> = {};
  const required: Record<string, RequiredLevel> = {};
  for (const c of universeControls) {
    visible[c] = xrm.getControlVisible(c);
    required[c] = xrm.getRequiredLevel(c);
  }
  return { visible, required };
}

function levelFor(severity: string | null): NotificationLevel {
  switch (severity) {
    case "Warning": return "WARNING";
    case "Error": return "ERROR";
    default: return "INFO"; // Information or null
  }
}

// The form state one cycle's fired actions add up to. Built with no Xrm mutation at all, so a
// cycle that cannot even be planned never touches the form.
interface PlannedState {
  visible: Record<string, boolean>;
  required: Record<string, RequiredLevel>;
  controlNotes: Array<{ name: string; message: string; uid: string }>;
  formNotes: Array<{ message: string; level: NotificationLevel; uid: string }>;
}

export class Applier {
  // What we believe is currently ON the form, updated as each Xrm call succeeds and never
  // ahead of reality, so a throw part-way through a commit still leaves an accurate record
  // for the next cycle (and for its retraction pass) to work from.
  private liveControlNotes: Array<{ name: string; uid: string }> = [];
  private liveFormNotes: string[] = [];

  constructor(
    private xrm: XrmAdapter,
    private baseline: Baseline,
    private universeControls: string[],
  ) {}

  // ATOMICITY. A `reset(); then re-apply` shape is not acceptable here: a throw from any Xrm
  // call in the re-apply would leave the user looking at a CLEAN form (the previous cycle's
  // blocking message gone) and concluding their record was now valid.
  //
  // The chosen shape is compute-then-commit with the destructive step LAST:
  //   1. plan():    fold the fired actions into the full next state. Pure w.r.t. the form.
  //   2. commit():  issue this cycle's notifications, THEN retract last cycle's that this one
  //                 does not re-issue, THEN drive every governed control to its final value.
  //
  // Snapshot-and-roll-back was considered and rejected: rolling back means re-issuing the
  // previous notifications through the very Xrm calls that just failed, so in the failure mode
  // that actually occurs (a form API that is throwing), the rollback throws too and the form
  // is wiped anyway. Ordering the commit so nothing is torn down before its replacement is
  // established needs no such second chance: the worst outcome of a throw is a form still
  // wearing last cycle's decoration, which is exactly what "retains the last successful
  // cycle's state" (docs/Client-Form-Library.md §5) promises.
  //
  // Note there is no reset-to-baseline pass any more. Controls are set straight to their
  // computed final value, which is idempotent, means no visible flicker, and means a partial
  // commit leaves a control on either its old or its new value, never stripped to baseline.
  apply(fired: FiredAction[]): void {
    this.commit(this.plan(fired));
  }

  private plan(fired: FiredAction[]): PlannedState {
    const next: PlannedState = {
      visible: { ...this.baseline.visible },
      required: { ...this.baseline.required },
      controlNotes: [],
      formNotes: [],
    };
    fired.forEach((a, i) => this.planOne(next, a, i));
    return next;
  }

  private commit(next: PlannedState): void {
    const keep = new Set<string>([
      ...next.controlNotes.map((n) => n.uid),
      ...next.formNotes.map((n) => n.uid),
    ]);

    // 1. Additive first. Re-issuing a uid the form already carries replaces it in place.
    for (const n of next.controlNotes) {
      this.xrm.setControlNotification(n.name, n.message, n.uid);
      if (!this.liveControlNotes.some((l) => l.name === n.name && l.uid === n.uid))
        this.liveControlNotes.push({ name: n.name, uid: n.uid });
    }
    for (const n of next.formNotes) {
      this.xrm.setFormNotification(n.message, n.level, n.uid);
      if (!this.liveFormNotes.includes(n.uid)) this.liveFormNotes.push(n.uid);
    }

    // 2. Only now retract what this cycle does not re-issue.
    for (const n of this.liveControlNotes.slice()) {
      if (keep.has(n.uid)) continue;
      this.xrm.clearControlNotification(n.name, n.uid);
      this.liveControlNotes = this.liveControlNotes.filter((l) => l !== n);
    }
    for (const uid of this.liveFormNotes.slice()) {
      if (keep.has(uid)) continue;
      this.xrm.clearFormNotification(uid);
      this.liveFormNotes = this.liveFormNotes.filter((l) => l !== uid);
    }

    // 3. Governed controls, straight to their final value. The universe (every column any
    //    rule's action targets) plus, defensively, anything the plan touched outside it.
    const governed = new Set<string>([
      ...this.universeControls,
      ...Object.keys(next.visible),
      ...Object.keys(next.required),
    ]);
    for (const c of governed) {
      if (c in next.visible) this.xrm.setControlVisible(c, next.visible[c]);
      if (c in next.required) this.xrm.setRequiredLevel(c, next.required[c]);
    }
  }

  // The index disambiguates notifications when one rule has multiple form-targeted
  // actions firing in the same cycle (e.g. a form-level Block + a ShowMessage). Without
  // it, two actions would share a uid and the platform would silently overwrite one.
  private uid(a: FiredAction, index: number): string {
    return `${a.ruleId}:${a.targetColumn ?? "form"}:${index}`;
  }

  private planOne(next: PlannedState, a: FiredAction, index: number): void {
    switch (a.actionType) {
      case "SetVisible":
        if (a.targetColumn) next.visible[a.targetColumn] = a.value === true;
        return;
      case "SetRequired":
        if (a.targetColumn)
          next.required[a.targetColumn] = a.value === true ? "required" : "none";
        return;
      case "ShowMessage": {
        const uid = this.uid(a, index);
        const msg = a.message ?? "";
        // Field-targeted: an inline notification on the control (addNotification), which
        // xrm.ts issues at ERROR because that is the ONLY level the platform renders, and
        // an ERROR control notification stops the save at validation. So a field-targeted
        // ShowMessage BLOCKS until its condition stops matching, whatever its severity.
        // A form-level one (below) banners and does not block; its severity is visual only.
        // See docs/Client-Form-Library.md §1, the action table and "Any message on a FIELD
        // stops the save".
        if (a.targetColumn && this.xrm.controlExists(a.targetColumn))
          next.controlNotes.push({ name: a.targetColumn, message: msg, uid });
        else next.formNotes.push({ message: msg, level: levelFor(a.severity), uid });
        return;
      }
      case "Block":
        this.planBlock(next, a, index);
        return;
      // CreateRecord and any unknown server action: ignored on the client.
      default:
        return;
    }
  }

  private planBlock(next: PlannedState, a: FiredAction, index: number): void {
    const uid = this.uid(a, index);
    const msg = a.message ?? "";
    if (a.targetColumn && this.xrm.controlExists(a.targetColumn)) {
      // Field-level: inline notification on the field ONLY. No form banner, because on save the
      // platform rolls the control notification up to the form header itself (field-named),
      // so a banner here would duplicate it. (See memory: a top-of-form banner during
      // editing for cross-tab visibility is a deferred future enhancement. It can't be
      // de-duplicated because OnSave runs after validation.)
      next.controlNotes.push({ name: a.targetColumn, message: msg, uid });
    } else {
      // Form-level (or target control not on the form): banner only, no field to
      // attach an inline to, so nothing for the platform to roll up. Server enforces.
      next.formNotes.push({ message: msg, level: "ERROR", uid });
    }
  }
}
