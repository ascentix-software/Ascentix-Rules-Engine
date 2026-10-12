import type { WebApiPort } from "../webapi";
import { loadRuleGraph } from "./index";
import { ENTITY, NAV } from "./odata";

interface Value { Kind: string; Value: string | null; Entity?: string; }
interface Row { Entity: string; Id: string; Attributes: { Key: string; Value: Value }[]; }

export async function loadPublishedGraph(definition: string, ruleId: string) {
  const snapshot = JSON.parse(definition) as { Format: number; RuleId: string; Rows: Row[] };
  if (snapshot.Format !== 1 || snapshot.RuleId.toLowerCase() !== ruleId.toLowerCase() || !Array.isArray(snapshot.Rows))
    throw new Error("Unsupported published revision.");
  const records = snapshot.Rows.map(row => {
    const raw: Record<string, any> = { [row.Entity + "id"]: row.Id };
    for (const { Key: key, Value: v } of row.Attributes) {
      if (v.Kind === "reference") raw[`_${key}_value`] = v.Value;
      else raw[key] = v.Kind === "null" ? null : v.Kind === "bool" ? v.Value?.toLowerCase() === "true" :
        ["int", "long", "double", "decimal", "option", "money"].includes(v.Kind) ? Number(v.Value) : v.Value;
    }
    return { entity: row.Entity, id: row.Id, raw };
  });
  const children = (entity: string, field: string, id: string) => records.filter(r => r.entity === entity && r.raw[field] === id).map(r => r.raw);
  for (const row of records) {
    if (row.entity === ENTITY.group) row.raw[NAV.groupConditions] = children(ENTITY.condition, "_asx_conditiongroup_value", row.id);
    if (row.entity === ENTITY.action) row.raw[NAV.actionLocalizedMessages] = children(ENTITY.localizedMessage, "_asx_ruleaction_value", row.id);
    if (row.entity === ENTITY.nodeFilterGroup) row.raw[NAV.filterGroupCriteria] = children(ENTITY.nodeFilterCriterion, "_asx_filtergroup_value", row.id);
    if (row.entity === ENTITY.actionConditionGroup) row.raw[NAV.actionConditionGroupTests] = children(ENTITY.actionConditionTest, "_asx_actionconditiongroup_value", row.id);
  }
  const byId = new Map(records.map(r => [r.id.toLowerCase(), r.raw]));
  const readonly = async (): Promise<never> => { throw new Error("Published revisions are read-only."); };
  const api: WebApiPort = {
    async retrieveRecord(entity, id) {
      const row = records.find(r => r.entity === entity && r.id.toLowerCase() === id.toLowerCase());
      if (!row) throw new Error(`Record ${id} is absent from this published revision.`);
      return row.raw;
    },
    async retrieveMultipleRecords(entity, options) {
      const filter = new URLSearchParams((options ?? "").replace(/^\?/, "")).get("$filter");
      // `field eq id`, or `lookup/field eq id` (the field of the record a lookup points to).
      const predicates = filter?.split(/\s+or\s+/).map(part => {
        const match = /^(?:(\w+)\/)?(\w+) eq ([0-9a-f-]+)$/i.exec(part.trim());
        if (!match) throw new Error("Unsupported published graph filter.");
        return { via: match[1]?.toLowerCase(), field: match[2], id: match[3].toLowerCase() };
      });
      const valueOf = (raw: Record<string, any>, p: { via?: string; field: string }) =>
        p.via ? byId.get(String(raw[`_${p.via}_value`]).toLowerCase())?.[p.field] : raw[p.field];
      return { entities: records.filter(r => r.entity === entity && (!predicates || predicates.some(p => String(valueOf(r.raw, p)).toLowerCase() === p.id)))
        .map(r => r.raw).sort((a, b) => (a.asx_order ?? 0) - (b.asx_order ?? 0)) };
    },
    createRecord: readonly, updateRecord: readonly, processRunPage: readonly,
    validateRule: readonly, publishRule: readonly, unpublishRule: readonly,
  };
  return loadRuleGraph(api, ruleId);
}
