import type { WebApiPort } from "../webapi";
import { loadRuleGraph } from "./index";
import { ENTITY, RULE_SELECT } from "./odata";
import { loadPublishedGraph } from "./publishedGraph";

// The route keeps the public rule identity while the editor loads its separate working copy.
export async function loadRuleEditorGraph(api: WebApiPort, ruleId: string) {
  const requested = await api.retrieveRecord(ENTITY.rule, ruleId, "?$select=" + RULE_SELECT);
  const activeId = requested._asx_draftof_value ?? ruleId;
  const active = activeId === ruleId ? requested : await api.retrieveRecord(ENTITY.rule, activeId, "?$select=" + RULE_SELECT);
  const drafts = await api.retrieveMultipleRecords(ENTITY.rule,
    `?$select=asx_ruleid&$filter=_asx_draftof_value eq ${activeId}&$top=2`);
  if (drafts.entities.length > 1) throw new Error("This rule has more than one working draft.");
  const draftId = drafts.entities[0]?.asx_ruleid;
  const graph = !draftId && (active.statuscode === 753840000 || active._asx_publishedrevision_value) && api.readPublishedRule
    ? await loadPublishedGraph(await api.readPublishedRule(activeId), activeId)
    : await loadRuleGraph(api, draftId ?? activeId);
  graph.rule.publishedRevisionId = active._asx_publishedrevision_value ?? null;
  graph.rule.publishedVersion = active.asx_publishedversion ?? 0;
  graph.rule.statusCode = active.statuscode ?? null;
  if (!draftId) graph.rule.etag = active["@odata.etag"] ?? null;
  if (draftId) {
    graph.rule.activeRuleId = activeId;
    graph.rule.activeEtag = active["@odata.etag"] ?? null;
  }
  return graph;
}
