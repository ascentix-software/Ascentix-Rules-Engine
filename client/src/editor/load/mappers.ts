import type { RuleHeader, ConditionNode, ActionNode, TableConfigRef, LocalizedMessage } from "../model/types";
import type { NodeFilterBlock, NodeFilterGroupModel, NodeFilterLeaf, NodeFilterNode } from "../model/nodeFilter";
import { newTempId } from "../model/ids";
import { conditionTypeLabel, actionTypeLabel, tableConfigTypeLabel, parseMultiSelect } from "../model/enums";
import { LOOKUP, NAV } from "./odata";

// Row version, threaded through the model to save/diff so a child PATCH can carry `If-Match`.
// Dataverse returns `@odata.etag` on every entity in a Web API response, including entities
// reached through `$expand`, but a missing annotation degrades to null (an unconditioned PATCH,
// which is what every child update did before), never to a guessed or stale value.
const etagOf = (raw: any): string | null => raw?.["@odata.etag"] ?? null;

const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const boolOrNull = (v: unknown): boolean | null => (v == null ? null : Boolean(v));
function parseStringArray(v: unknown): string[] {
  if (v == null || v === "") return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function mapRuleHeader(raw: any): RuleHeader {
  return {
    id: raw.asx_ruleid,
    name: raw.asx_name ?? "",
    tableLogicalName: raw.asx_tablelogicalname ?? "",
    statusCode: numOrNull(raw.statuscode),
    publishedRevisionId: strOrNull(raw._asx_publishedrevision_value),
    publishedVersion: Number(raw.asx_publishedversion ?? 0),
    etag: raw["@odata.etag"] ?? null,
    triggers: parseMultiSelect(raw.asx_triggers),
    channels: parseMultiSelect(raw.asx_channels),
    effectiveFrom: strOrNull(raw.asx_effectivefrom),
    effectiveTo: strOrNull(raw.asx_effectiveto),
    evaluationContext: numOrNull(raw.asx_evaluationcontext),
    rootTableConfigId: strOrNull(raw[LOOKUP.ruleOfTableConfig]),
    triggerColumns: parseStringArray(raw.asx_triggercolumns),
  };
}

export function mapConditionRecord(raw: any): ConditionNode {
  return {
    id: raw.asx_ruleconditionid,
    name: raw.asx_name ?? "",
    etag: etagOf(raw),
    tableConfigId: strOrNull(raw[LOOKUP.conditionTableConfig]),
    conditionType: conditionTypeLabel(numOrNull(raw.asx_conditiontype)),
    comparisonColumn: strOrNull(raw.asx_comparisoncolumn),
    comparisonOperator: numOrNull(raw.asx_comparisonoperator),
    valueSource: numOrNull(raw.asx_comparisonvaluesource),
    comparisonValue: strOrNull(raw.asx_comparisonvalue),
    comparisonValueColumn: strOrNull(raw.asx_comparisonvaluecolumn),
    comparisonValueNodeId: strOrNull(raw[LOOKUP.comparisonValueNode]),
    minExpectedRows: numOrNull(raw.asx_minexpectedrows),
    maxExpectedRows: numOrNull(raw.asx_maxexpectedrows),
    expression: strOrNull(raw.asx_conditionexpression),
  };
}

export function mapActionRecord(raw: any): ActionNode {
  return {
    id: raw.asx_ruleactionid,
    name: raw.asx_name ?? "",
    etag: etagOf(raw),
    order: numOrNull(raw.asx_order) ?? 0,
    actionType: actionTypeLabel(numOrNull(raw.asx_actiontype)),
    fireOn: numOrNull(raw.asx_fireon),
    targetColumn: strOrNull(raw.asx_targetcolumn),
    targetTable: strOrNull(raw.asx_targettable),
    targetNodeId: strOrNull(raw[LOOKUP.actionTargetNode]),
    message: strOrNull(raw.asx_message),
    fieldMapping: strOrNull(raw.asx_fieldmapping),
    value: boolOrNull(raw.asx_valuebool),
    applyInverseWhenNotFired: boolOrNull(raw.asx_applyinversewhennotfired),
    severity: numOrNull(raw.asx_severity),
    isActive: boolOrNull(raw.asx_isactive),
    localizedMessages: Array.isArray(raw[NAV.actionLocalizedMessages])
      ? raw[NAV.actionLocalizedMessages].map(mapLocalizedMessage)
      : [],
  };
}

export function mapLocalizedMessage(raw: any): LocalizedMessage {
  return {
    id: raw.asx_localizedmessageid,
    etag: etagOf(raw),
    languageCode: numOrNull(raw.asx_languagecode) ?? 0,
    message: raw.asx_message ?? "",
  };
}

export function mapTableConfig(raw: any): TableConfigRef {
  return {
    id: raw.asx_tableconfigid,
    name: raw.asx_name ?? "",
    etag: etagOf(raw),
    tableLogicalName: raw.asx_tablelogicalname ?? "",
    tableConfigType: tableConfigTypeLabel(numOrNull(raw.asx_tableconfigtype)),
    parentTableConfigId: strOrNull(raw[LOOKUP.parentTableOfConfig]),
    lookupColumnLogicalName: strOrNull(raw.asx_lookupcolumnlogicalname),
    childLinkField: strOrNull(raw.asx_childlinkfield),
    lookupTargetIdAttribute: strOrNull(raw.asx_lookuptargetidattribute),
  };
}

// Inverse of ui/pickers/recordFilter.ts's operatorToFetchOp table (the C# ComparisonOperator
// codes): asx_operator is stored as a text token on asx_nodefiltercriterion, the client model's
// `operator` is the numeric code. like/contains collapse to 7 and not-like/not-contains to 8:
// the engine treats them identically as substring match, so the round-trip is lossy by design
// (the writer always serializes 7 back out as "like" / 8 as "not-like").
const OPERATOR_TOKEN_TO_CODE: Record<string, number> = {
  eq: 1, ne: 2, gt: 3, ge: 4, lt: 5, le: 6,
  like: 7, contains: 7,
  "not-like": 8, "not-contains": 8,
  null: 9, "not-null": 10,
};
function operatorTokenToCode(token: unknown): number | null {
  if (token == null || token === "") return null;
  return OPERATOR_TOKEN_TO_CODE[String(token)] ?? null;
}

function mapFilterLeaf(raw: any): NodeFilterLeaf {
  return {
    kind: "rule",
    id: raw.asx_nodefiltercriterionid,
    etag: etagOf(raw),
    column: strOrNull(raw.asx_fieldname),
    operator: operatorTokenToCode(raw.asx_operator),
    valueSource: numOrNull(raw.asx_comparisonvaluesource) ?? 1,
    value: strOrNull(raw.asx_value),
    valueNodeId: strOrNull(raw[LOOKUP.filterCriterionValueNode]),
    valueColumn: strOrNull(raw.asx_comparisonvaluecolumn),
  };
}

// Fallback `sub` when the caller didn't fetch/pass a sub-filter row for this criterion (keeps
// the model invariant "an exists node always carries a sub", per nodeFilter.ts). Deliberately
// NOT nodeFilter.ts's emptyGroup(): that seeds one blank editable leaf for the "new node in the
// UI" case, which would misrepresent a load-time gap as a row the author typed. A truly empty
// rules list reflects "no data was found" (a temp id so an eventual save creates the missing row).
function emptyLoadedSubFilter(): NodeFilterGroupModel {
  return { kind: "group", id: newTempId(), op: "and", rules: [] };
}

// asx_criteriontype: absent/Comparison(1) -> the existing scalar leaf (back-compat with rows
// that predate the Exists kind). Exists(2) -> a NodeFilterExists node; its `sub` is the
// pre-rebuilt sub-filter tree owned by this criterion (see mapExistsSubFilters/collectExists-
// CriterionIds), keyed by this criterion's own id.
function mapFilterCriterion(
  raw: any,
  subFiltersByCriterion: Record<string, NodeFilterGroupModel>,
): NodeFilterNode {
  const kind = numOrNull(raw.asx_criteriontype);
  if (kind === 2) {
    const critId = raw.asx_nodefiltercriterionid;
    return {
      kind: "exists",
      id: critId,
      etag: etagOf(raw),
      collectionNodeId: strOrNull(raw[LOOKUP.filterCriterionCollectionNode]),
      minCount: numOrNull(raw.asx_mincount),
      maxCount: numOrNull(raw.asx_maxcount),
      sub: subFiltersByCriterion[critId] ?? emptyLoadedSubFilter(),
    };
  }
  return mapFilterLeaf(raw);
}

// Shallow group (rules resolved from the expanded criteria nav property; child groups are
// attached by the caller once every row's node is known). No targetNodeId here: target lives
// on the NodeFilterBlock the group ends up as (root) or inherits from (nested).
function mapFilterGroupShallow(
  raw: any,
  subFiltersByCriterion: Record<string, NodeFilterGroupModel>,
): NodeFilterGroupModel {
  const criteria = raw[NAV.filterGroupCriteria] ?? [];
  const rules: NodeFilterNode[] = Array.isArray(criteria)
    ? criteria.map((c: any) => mapFilterCriterion(c, subFiltersByCriterion))
    : [];
  const opValue = raw.asx_logicaloperator == null ? null : Number(raw.asx_logicaloperator);
  return {
    kind: "group",
    id: raw.asx_nodefiltergroupid,
    etag: etagOf(raw),
    op: opValue === 2 ? "or" : "and", // mirrors enums.ts logicalOperatorLabel: 1=And, 2=Or
    rules,
  };
}

// Rebuilds a self-referential asx_nodefiltergroup forest from a flat row array: buckets rows by
// `ownerLookup`'s value, then attaches nested children via the parent-filter-group lookup. Every
// row whose parent is null/absent (or points outside this owner's bucket) is a top-level root.
// An owner can have MULTIPLE top-level roots (e.g. a condition filtering several target nodes),
// so ALL of them are returned (never just the first) or a save->load round-trip silently loses
// data. Used by the per-condition tree (mapNodeFilterTrees), where asx_rulecondition is
// denormalized onto EVERY group (root and nested) so bucketing by owner alone is sound. NOT used
// for the per-criterion EXISTS sub-filter tree (mapExistsSubFilters): asx_owningcriterion is
// root-only there, so nested rows would have no owner to bucket into; see that function's own
// (different) tree-building logic.
function buildFilterGroupForest(
  rows: any[],
  ownerLookup: string,
  subFiltersByCriterion: Record<string, NodeFilterGroupModel>,
): Map<string, { raw: any; node: NodeFilterGroupModel }[]> {
  const rowsByOwner = new Map<string, any[]>();
  for (const raw of rows) {
    const ownerId = raw[ownerLookup];
    if (!ownerId) continue;
    if (!rowsByOwner.has(ownerId)) rowsByOwner.set(ownerId, []);
    rowsByOwner.get(ownerId)!.push(raw);
  }

  const result = new Map<string, { raw: any; node: NodeFilterGroupModel }[]>();
  for (const [ownerId, groupRows] of rowsByOwner) {
    const nodes = new Map<string, NodeFilterGroupModel>();
    for (const raw of groupRows) {
      nodes.set(raw.asx_nodefiltergroupid, mapFilterGroupShallow(raw, subFiltersByCriterion));
    }

    const roots: { raw: any; node: NodeFilterGroupModel }[] = [];
    for (const raw of groupRows) {
      const node = nodes.get(raw.asx_nodefiltergroupid)!;
      const parentId = raw[LOOKUP.filterParentGroup];
      if (parentId && nodes.has(parentId)) {
        nodes.get(parentId)!.rules.push(node);
      } else {
        roots.push({ raw, node });
      }
    }
    result.set(ownerId, roots);
  }
  return result;
}

// EXISTS sub-filters: asx_nodefiltergroup rows owned by a criterion (asx_owningcriterion) rather
// than a condition. UNLIKE asx_rulecondition on the primary condition-tree (denormalized across
// every group, root and nested, per diff.ts's per-group binds), asx_owningcriterion is ROOT-ONLY
// (docs/Schema.md "Exists sub-filter root"): only the root sub-filter group carries it; nested
// descendant groups have it null and link to their parent via _asx_parentfiltergroup_value
// instead. So `rows` here is expected to be the FULL set the caller already BFS-walked down via
// parentfiltergroup (see load/index.ts): root(s) plus every nested descendant. This
// function links them into trees by parent regardless of which rows happen to carry
// owningcriterion, then picks out the owningcriterion-tagged row as each tree's root. Exactly one
// root per criterion (an exists node has a single `sub` group, never a list of blocks). `{}` is
// passed as the nested subFiltersByCriterion map to mapFilterGroupShallow because a sub-filter is
// scalar-only (one-level nesting rule: no Exists-within-Exists), so its own criteria never need one.
export function mapExistsSubFilters(rows: any[]): Record<string, NodeFilterGroupModel> {
  const nodes = new Map<string, NodeFilterGroupModel>();
  for (const raw of rows) {
    nodes.set(raw.asx_nodefiltergroupid, mapFilterGroupShallow(raw, {}));
  }
  for (const raw of rows) {
    const parentId = raw[LOOKUP.filterParentGroup];
    if (parentId && nodes.has(parentId)) {
      nodes.get(parentId)!.rules.push(nodes.get(raw.asx_nodefiltergroupid)!);
    }
  }
  const result: Record<string, NodeFilterGroupModel> = {};
  for (const raw of rows) {
    const criterionId = raw[LOOKUP.filterGroupOwningCriterion];
    if (criterionId) result[criterionId] = nodes.get(raw.asx_nodefiltergroupid)!;
  }
  return result;
}

// Scans raw asx_nodefiltergroup rows (with expanded criteria) for Exists-kind criteria at any
// depth, returning their ids. The caller (load/index.ts) uses this to fetch those criteria's
// owned sub-filter groups in a second query. See the module-level gotcha note on
// mapNodeFilterTrees below.
export function collectExistsCriterionIds(rows: any[]): string[] {
  const ids = new Set<string>();
  for (const raw of rows) {
    const criteria = raw[NAV.filterGroupCriteria];
    if (!Array.isArray(criteria)) continue;
    for (const c of criteria) {
      if (numOrNull(c.asx_criteriontype) === 2 && c.asx_nodefiltercriterionid) {
        ids.add(c.asx_nodefiltercriterionid);
      }
    }
  }
  return [...ids];
}

// Rebuild the self-referential asx_nodefiltergroup tree (grouped by owning condition) into a
// map of conditionId -> NodeFilterBlock[].
//
// GOTCHA (mirrors the engine RuleLoader.LoadExistsSubFilters): an Exists criterion's sub-filter
// root group is owned by the CRITERION (asx_owningcriterion), NOT by a condition, so `rows` alone
// never contains it. The caller must fetch the root(s) separately (filtered on
// `_asx_owningcriterion_value`), then BFS-descend any nested groups via
// `_asx_parentfiltergroup_value` (owningcriterion is root-only), and pass the WHOLE set (root +
// nested) as `subFilterRows`. Without it, Exists nodes still build correctly but with an empty
// (or incomplete, missing nested groups) `sub`.
export function mapNodeFilterTrees(rows: any[], subFilterRows: any[] = []): Record<string, NodeFilterBlock[]> {
  const subFiltersByCriterion = mapExistsSubFilters(subFilterRows);
  const forest = buildFilterGroupForest(rows, LOOKUP.filterGroupCondition, subFiltersByCriterion);

  const result: Record<string, NodeFilterBlock[]> = {};
  for (const [condId, roots] of forest) {
    const blocks: NodeFilterBlock[] = roots.map(({ raw, node }) => ({
      targetNodeId: strOrNull(raw[LOOKUP.filterGroupTargetNode]),
      root: node,
    }));
    if (blocks.length) result[condId] = blocks;
  }
  return result;
}
