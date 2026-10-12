import type { ActionTypeLabel } from "./types";

// asx_triggers values (RuleTrigger in Ascentix.RulesEngine.Core/Models/Enums.cs).
const ON_CREATE = 1;
const ON_FORM = 2;
const ON_DEMAND = 3;
const ON_UPDATE = 4;
const ON_DELETE = 5;

const SERVER = [ON_CREATE, ON_UPDATE, ON_DELETE, ON_DEMAND];

/**
 * The triggers under which each action type has an effect. Form changes and messages are
 * applied by the form library (applier.ts), and a save on the server ignores them
 * (ActionDispatcher.IsServerAction), so they need On form, or On demand, whose dry-run API
 * (asx_RunRules) returns them to any caller. Writes run on the server: on a save or an On demand
 * run. Block works everywhere: it stops a form save, a server save, or a record in a run.
 */
const RUNS_ON: Record<ActionTypeLabel, number[]> = {
  SetVisible: [ON_FORM, ON_DEMAND],
  SetRequired: [ON_FORM, ON_DEMAND],
  ShowMessage: [ON_FORM, ON_DEMAND],
  Block: [ON_FORM, ...SERVER],
  CreateRecord: SERVER,
  UpdateRecord: SERVER,
  DeleteRecord: SERVER,
  DeactivateRecord: SERVER,
};

/** Whether an action of this type does anything under these triggers. A rule with no triggers
 *  yet restricts nothing: the missing trigger is its own issue. */
export function actionRunsOn(type: ActionTypeLabel | null, triggers: number[]): boolean {
  if (!type || triggers.length === 0) return true;
  return RUNS_ON[type].some((t) => triggers.includes(t));
}

/** Why the type is unavailable, short enough for a dropdown option: "Needs On form". */
export function missingTriggerShort(type: ActionTypeLabel): string {
  return RUNS_ON[type].includes(ON_CREATE) ? "Needs a save or On demand trigger" : "Needs On form";
}

/** The fix, as an instruction for the Issues list. */
export function missingTriggerHint(type: ActionTypeLabel): string {
  return RUNS_ON[type].includes(ON_CREATE)
    ? "This action only runs when a record is saved or run on demand. Add On create, On update, On delete or On demand to the triggers, or choose another type."
    : "This action only works on the form. Add On form to the triggers, or choose another type.";
}

/** A new action's type: a message when the rule runs on the form, else a Block (which runs
 *  under every trigger). */
export function defaultActionType(triggers: number[]): ActionTypeLabel {
  return actionRunsOn("ShowMessage", triggers) ? "ShowMessage" : "Block";
}
