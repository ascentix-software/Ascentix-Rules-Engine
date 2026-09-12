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
  }
  const readonly = async (): Promise<never> => { throw new Error("Published revisions are read-only."); };
  const api: WebApiPort = {
    async retrieveRecord(entity, id) {
      const row = records.find(r => r.entity === entity && r.id.toLowerCase() === id.toLowerCase());
      if (!row) throw new Error(`Record ${id} is absent from this published revision.`);
      return row.raw;
    },
    async retrieveMultipleRecords(entity, options) {
      const filter = new URLSearchParams((options ?? "").replace(/^\?/, "")).get("$filter");
      const predicates = filter?.split(/\s+or\s+/).map(part => {
        const match = /^(\w+) eq ([0-9a-f-]+)$/i.exec(part.trim());
        if (!match) throw new Error("Unsupported published graph filter.");
        return { field: match[1], id: match[2].toLowerCase() };
      });
      return { entities: records.filter(r => r.entity === entity && (!predicates || predicates.some(p => String(r.raw[p.field]).toLowerCase() === p.id)))
        .map(r => r.raw).sort((a, b) => (a.asx_order ?? 0) - (b.asx_order ?? 0)) };
    },
    createRecord: readonly, validateRule: readonly, publishRule: readonly, unpublishRule: readonly,
  };
  return loadRuleGraph(api, ruleId);
}
