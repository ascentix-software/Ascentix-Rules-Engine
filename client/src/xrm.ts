export type RequiredLevel = "none" | "required" | "recommended";
export type NotificationLevel = "INFO" | "WARNING" | "ERROR";

// The only interface that abstracts the Dynamics form API. All rules-engine
// logic depends on this, never on the Xrm global directly, so it is mockable.
export interface XrmAdapter {
  getTableLogicalName(): string;
  getRecordId(): string | null; // null if unsaved; braces stripped

  hasAttribute(name: string): boolean;          // attribute present on this form layout
  getAttributeType(name: string): string | null; // Xrm attribute type, or null if absent
  getValue(name: string): unknown;              // raw attribute getValue()

  controlExists(name: string): boolean;          // at least one control on the form
  getControlVisible(name: string): boolean;
  setControlVisible(name: string, visible: boolean): void;
  setSectionVisible(section: string, visible: boolean): void;
  getRequiredLevel(name: string): RequiredLevel;
  setRequiredLevel(name: string, level: RequiredLevel): void;

  setControlNotification(name: string, message: string, uid: string): void;
  clearControlNotification(name: string, uid: string): void;
  setFormNotification(message: string, level: NotificationLevel, uid: string): void;
  clearFormNotification(uid: string): void;

  addOnChange(name: string, handler: () => void): void;
}

// Real adapter over a Dynamics formContext. Thin pass-through; verified in a
// live smoke test, not unit tests. A column can have multiple
// controls: visibility/notifications apply to all of them.
export function createXrmAdapter(formContext: Xrm.FormContext): XrmAdapter {
  const attr = (n: string) => formContext.getAttribute(n) || null;
  const controlsFor = (n: string): Xrm.Controls.StandardControl[] => {
    const a = attr(n);
    if (!a) return [];
    return (a.controls.get() as Xrm.Controls.StandardControl[]) || [];
  };
  return {
    getTableLogicalName: () => formContext.data.entity.getEntityName(),
    getRecordId: () => {
      const id = formContext.data.entity.getId();
      return id ? id.replace(/[{}]/g, "") : null;
    },
    hasAttribute: (n) => attr(n) !== null,
    getAttributeType: (n) => (attr(n) ? attr(n)!.getAttributeType() : null),
    getValue: (n) => (attr(n) ? attr(n)!.getValue() : null),
    controlExists: (n) => controlsFor(n).length > 0,
    getControlVisible: (n) => {
      const c = controlsFor(n)[0];
      return c ? c.getVisible() : true;
    },
    setControlVisible: (n, v) => controlsFor(n).forEach((c) => c.setVisible(v)),
    setSectionVisible: (section, visible) => {
      formContext.ui.tabs.forEach((tab) => {
        const s = tab.sections.get(section);
        if (s) s.setVisible(visible);
      });
    },
    getRequiredLevel: (n) => {
      const a = attr(n);
      return (a ? a.getRequiredLevel() : "none") as RequiredLevel;
    },
    setRequiredLevel: (n, level) => {
      const a = attr(n);
      if (a) a.setRequiredLevel(level);
    },
    // Inline notification on the control (addNotification, NOT setNotification). ERROR is
    // the only level the platform actually RENDERS inline, and an ERROR control notification
    // stops the save at the form's validation stage. So this call blocks: a field-targeted
    // ShowMessage or Block holds the save until its condition stops matching. RECOMMENDATION
    // neither blocks nor displays anything, so there is no useful second level to offer here
    // and hence no level parameter on the port. A FORM-level notification (setFormNotification
    // below) banners and does not block. See docs/Client-Form-Library.md §1: the action
    // table and "Any message on a FIELD stops the save". The server plugin remains the
    // authoritative enforcer for non-form writes.
    setControlNotification: (n, message, uid) =>
      controlsFor(n).forEach((c) =>
        c.addNotification({ messages: [message], notificationLevel: "ERROR", uniqueId: uid })),
    clearControlNotification: (n, uid) =>
      controlsFor(n).forEach((c) => c.clearNotification(uid)),
    setFormNotification: (message, level, uid) =>
      formContext.ui.setFormNotification(message, level, uid),
    clearFormNotification: (uid) => formContext.ui.clearFormNotification(uid),
    addOnChange: (n, handler) => {
      const a = attr(n);
      if (a) a.addOnChange(() => handler());
    },
  };
}
