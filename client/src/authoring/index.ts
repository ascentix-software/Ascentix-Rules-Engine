import type { XrmAdapter } from "../xrm";
import { createXrmAdapter } from "../xrm";
import type { VisibilityMap } from "./visibility";
import { conditionVisibility, actionVisibility, tableConfigVisibility } from "./visibility";

export function applyMap(xrm: XrmAdapter, map: VisibilityMap): void {
  // Visibility is a CONTROL concern: gate it on controlExists, not hasAttribute.
  // Subgrids, web resources and iframes are controls with no backing attribute, so
  // gating them on hasAttribute made every such entry (e.g. the RowCount
  // search-criteria grid) a permanent no-op on the real form.
  const ctrl = map.controls;
  for (const name in ctrl)
    if (xrm.controlExists(name)) xrm.setControlVisible(name, ctrl[name]);
  // Sections are addressed by name, not by attribute; the adapter no-ops when the
  // section is absent from every tab, so no gate is needed (nor available) here.
  const sect = map.sections;
  for (const section in sect) xrm.setSectionVisible(section, sect[section]);
  // Required level is an ATTRIBUTE concern, meaningless on an attribute-less
  // control, so this one genuinely stays gated on hasAttribute.
  const req = map.required;
  if (req)
    for (const name in req)
      if (xrm.hasAttribute(name)) xrm.setRequiredLevel(name, req[name] ? "required" : "none");
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function registerCondition(xrm: XrmAdapter): void {
  const recompute = () =>
    applyMap(xrm, conditionVisibility(num(xrm.getValue("asx_conditiontype")), num(xrm.getValue("asx_comparisonvaluesource"))));
  xrm.addOnChange("asx_conditiontype", recompute);
  xrm.addOnChange("asx_comparisonvaluesource", recompute);
  recompute();
}
export function registerAction(xrm: XrmAdapter): void {
  const recompute = () => applyMap(xrm, actionVisibility(num(xrm.getValue("asx_actiontype"))));
  xrm.addOnChange("asx_actiontype", recompute);
  recompute();
}
export function registerTableConfig(xrm: XrmAdapter): void {
  const recompute = () => applyMap(xrm, tableConfigVisibility(num(xrm.getValue("asx_tableconfigtype"))));
  xrm.addOnChange("asx_tableconfigtype", recompute);
  recompute();
}

function onLoad(executionContext: Xrm.Events.EventContext, register: (x: XrmAdapter) => void): void {
  try { register(createXrmAdapter(executionContext.getFormContext())); }
  catch (e) { console.error("Ascentix Authoring: visibility wiring failed.", e); }
}

if (typeof window !== "undefined") {
  const ns = ((window as any).Ascentix = (window as any).Ascentix || {});
  ns.Authoring = {
    onConditionLoad: (c: Xrm.Events.EventContext) => onLoad(c, registerCondition),
    onActionLoad: (c: Xrm.Events.EventContext) => onLoad(c, registerAction),
    onTableConfigLoad: (c: Xrm.Events.EventContext) => onLoad(c, registerTableConfig),
  };
}
