import type { XrmAdapter, RequiredLevel, NotificationLevel } from "../src/xrm";

export interface MockAttr {
  type: string;
  value: unknown;
  control?: boolean;      // a control exists on the form (default false)
  visible?: boolean;      // default true
  required?: RequiredLevel; // default "none"
}

export interface MockState {
  tableLogicalName: string;
  recordId: string | null;
  attributes: Record<string, MockAttr>;
  sections?: string[];
  // Controls that exist on the form but have NO backing attribute: subgrids, web
  // resources, iframes, quick-view controls. On a real form `getAttribute(name)`
  // returns null for these, so `hasAttribute` is false while `controlExists` is
  // true. Keeping them out of `attributes` is what lets L1 tell the two apart.
  controlsWithoutAttributes?: string[];
}

// Adapter methods that can be made to throw. Named exactly as on XrmAdapter so a test reads
// like the fault it is injecting. Faulting the form API is the ONLY way to reach the applier's
// throw path (no network manipulation can induce it), and until this
// existed L1 could not exercise it at all.
export type FaultableMethod =
  | "setControlVisible"
  | "setRequiredLevel"
  | "setControlNotification"
  | "clearControlNotification"
  | "setFormNotification"
  | "clearFormNotification"
  | "controlExists";

export interface MockXrm extends XrmAdapter {
  controlNotifications(): Array<{ name: string; message: string; uid: string }>;
  formNotifications(): Array<{ message: string; level: NotificationLevel; uid: string }>;
  fireOnChange(name: string): void;
  sectionVisibility(): Record<string, boolean>;
  __setValue(name: string, value: unknown): void;
  // Make `method` throw on every subsequent call (message defaults to a self-describing one).
  __failOn(method: FaultableMethod, message?: string): void;
  // Stop faulting `method`, or all of them when called with no argument.
  __clearFault(method?: FaultableMethod): void;
}

export function createMockXrm(state: MockState): MockXrm {
  const ctrlNotes: Array<{ name: string; message: string; uid: string }> = [];
  const formNotes: Array<{ message: string; level: NotificationLevel; uid: string }> = [];
  const onChange: Record<string, Array<() => void>> = {};
  const a = (n: string): MockAttr | undefined => state.attributes[n];
  const sectionVis: Record<string, boolean> = {};
  for (const s of state.sections ?? []) sectionVis[s] = true;
  // attribute-less controls: name -> visible (default true)
  const bareCtrlVis: Record<string, boolean> = {};
  for (const c of state.controlsWithoutAttributes ?? []) bareCtrlVis[c] = true;
  const isBareControl = (n: string) => Object.prototype.hasOwnProperty.call(bareCtrlVis, n);
  const faults: Partial<Record<FaultableMethod, string>> = {};
  const guard = (m: FaultableMethod): void => {
    const msg = faults[m];
    if (msg !== undefined) throw new Error(msg);
  };

  return {
    getTableLogicalName: () => state.tableLogicalName,
    getRecordId: () => state.recordId,
    hasAttribute: (n) => a(n) !== undefined,
    getAttributeType: (n) => (a(n) ? a(n)!.type : null),
    getValue: (n) => (a(n) ? a(n)!.value : null),
    controlExists: (n) => { guard("controlExists"); return !!a(n)?.control || isBareControl(n); },
    getControlVisible: (n) => (isBareControl(n) ? bareCtrlVis[n] : a(n)?.visible ?? true),
    setControlVisible: (n, v) => {
      guard("setControlVisible");
      if (isBareControl(n)) bareCtrlVis[n] = v;
      else if (a(n)) a(n)!.visible = v;
    },
    setSectionVisible: (section, visible) => { if (section in sectionVis) sectionVis[section] = visible; },
    getRequiredLevel: (n) => a(n)?.required ?? "none",
    setRequiredLevel: (n, level) => { guard("setRequiredLevel"); if (a(n)) a(n)!.required = level; },
    setControlNotification: (n, message, uid) => {
      guard("setControlNotification");
      // The platform's store is keyed by uid: re-issuing one replaces it in place.
      const at = ctrlNotes.findIndex((x) => x.name === n && x.uid === uid);
      if (at >= 0) ctrlNotes[at] = { name: n, message, uid };
      else ctrlNotes.push({ name: n, message, uid });
    },
    clearControlNotification: (n, uid) => {
      guard("clearControlNotification");
      for (let i = ctrlNotes.length - 1; i >= 0; i--)
        if (ctrlNotes[i].name === n && ctrlNotes[i].uid === uid) ctrlNotes.splice(i, 1);
    },
    setFormNotification: (message, level, uid) => {
      guard("setFormNotification");
      const at = formNotes.findIndex((x) => x.uid === uid);
      if (at >= 0) formNotes[at] = { message, level, uid };
      else formNotes.push({ message, level, uid });
    },
    clearFormNotification: (uid) => {
      guard("clearFormNotification");
      for (let i = formNotes.length - 1; i >= 0; i--)
        if (formNotes[i].uid === uid) formNotes.splice(i, 1);
    },
    addOnChange: (n, handler) => { (onChange[n] ||= []).push(handler); },
    // test-only inspectors / triggers:
    controlNotifications: () => ctrlNotes.slice(),
    formNotifications: () => formNotes.slice(),
    fireOnChange: (n) => (onChange[n] || []).forEach((h) => h()),
    sectionVisibility: () => ({ ...sectionVis }),
    __setValue: (name, value) => { const at = a(name); if (at) at.value = value; },
    __failOn: (method, message) => { faults[method] = message ?? `mockXrm: injected fault in ${method}`; },
    __clearFault: (method) => {
      if (method) delete faults[method];
      else for (const k of Object.keys(faults)) delete faults[k as FaultableMethod];
    },
  };
}
