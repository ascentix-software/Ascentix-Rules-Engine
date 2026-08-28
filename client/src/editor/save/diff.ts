import type {
  RuleGraph, ConditionGroupNode, ConditionNode, ActionNode,
} from "../model/types";
import type { NodeFilterBlock, NodeFilterGroupModel, NodeFilterLeaf } from "../model/nodeFilter";
import { isBlockEmpty } from "../model/nodeFilter";
import { isNewId } from "../model/ids";
import { flattenGroups, flattenConditions } from "../model/tree";
import { logicalOperatorValue, conditionTypeValue, actionTypeValue, encodeMultiSelect, tableConfigTypeValue } from "../model/enums";
import { operatorToFetchOp } from "../ui/pickers/recordFilter";
import { isLeafComplete } from "../model/nodeFilter";
import { ENTITY, ENTITY_SET, BIND_NAV } from "../load/odata";

export type BindRef = { kind: "existing"; id: string } | { kind: "new"; tempId: string };
export interface Bind { navProp: string; targetSet: string; ref: BindRef; }
export interface CreateOp {
  kind: "create"; entity: string; set: string; tempId: string;
  attrs: Record<string, any>; binds: Bind[];
}
export interface UpdateOp {
  kind: "update"; entity: string; set: string; id: string;
  // Row version of the SNAPSHOT row this update was diffed against, emitted as `If-Match` by
  // buildBatch. null ⇒ unconditioned PATCH (last-write-wins), used only when the load surfaced
  // no etag or the row has no snapshot baseline. Never a guessed or reconstructed value: an
  // If-Match on an invented etag is worse than none.
  attrs: Record<string, any>; binds: Bind[]; etag: string | null;
}
// The optimistic-concurrency token for an update always comes from the SNAPSHOT (the version the
// author's edits were made against), never from the working copy: the working row is a clone of
// the snapshot row, so the two agree today, but only the snapshot is definitionally the baseline.
const etagOf = (prev: { etag?: string | null } | null | undefined): string | null => prev?.etag ?? null;
export interface DeleteOp { kind: "delete"; entity: string; set: string; id: string; }
export type Operation = CreateOp | UpdateOp | DeleteOp;

const ref = (id: string): BindRef => (isNewId(id) ? { kind: "new", tempId: id } : { kind: "existing", id });

function groupAttrs(g: ConditionGroupNode): Record<string, any> {
  return {
    asx_name: g.name,
    asx_logicaloperator: logicalOperatorValue(g.logicalOperator),
    asx_isexecutioncondition: g.isExecutionCondition,
  };
}
function tableConfigAttrs(n: import("../model/types").TableConfigRef): Record<string, any> {
  return {
    asx_name: n.name,
    asx_tableconfigtype: n.tableConfigType ? tableConfigTypeValue(n.tableConfigType) : null,
    asx_tablelogicalname: n.tableLogicalName,
    asx_lookupcolumnlogicalname: n.lookupColumnLogicalName,
    asx_childlinkfield: n.childLinkField,
    asx_lookuptargetidattribute: n.lookupTargetIdAttribute,
  };
}
function conditionAttrs(c: ConditionNode): Record<string, any> {
  return {
    asx_name: c.name,
    asx_conditiontype: c.conditionType ? conditionTypeValue(c.conditionType) : null,
    asx_comparisoncolumn: c.comparisonColumn,
    asx_comparisonoperator: c.comparisonOperator,
    asx_comparisonvaluesource: c.valueSource,
    asx_comparisonvalue: c.comparisonValue,
    asx_comparisonvaluecolumn: c.comparisonValueColumn,
    asx_minexpectedrows: c.minExpectedRows,
    asx_maxexpectedrows: c.maxExpectedRows,
    asx_conditionexpression: c.expression ?? null,
  };
}
function localizedAttrs(m: { languageCode: number; message: string }): Record<string, any> {
  return { asx_languagecode: m.languageCode, asx_message: m.message };
}
function actionAttrs(a: ActionNode): Record<string, any> {
  return {
    asx_name: a.name,
    asx_order: a.order,
    asx_actiontype: a.actionType ? actionTypeValue(a.actionType) : null,
    asx_fireon: a.fireOn,
    asx_targetcolumn: a.targetColumn,
    asx_targettable: a.targetTable,
    asx_message: a.message,
    asx_fieldmapping: a.fieldMapping,
    asx_valuebool: a.value,
    asx_applyinversewhennotfired: a.applyInverseWhenNotFired,
    asx_severity: a.severity,
    asx_isactive: a.isActive,
  };
}

// Only the keys present in `attrs` are compared (lookups are diffed separately).
function changedAttrs(prev: Record<string, any>, next: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(next)) {
    if (JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null)) out[k] = next[k];
  }
  return out;
}

// ---- Node filters (asx_nodefiltergroup / asx_nodefiltercriterion) ----
// A "persisted" record (one row that will actually be created/updated/deleted in Dataverse)
// as opposed to a NodeFilterGroupModel/NodeFilterLeaf model node. See flattenFilterBlocks: with
// the list-of-blocks model these ARE 1:1 (no split needed: each block already targets one node).
interface PersistedFilterGroup {
  persistedId: string;
  /** Row version carried over from the model node, for the update's If-Match (see UpdateOp.etag). */
  etag: string | null;
  op: "and" | "or";
  targetNodeId: string | null;
  parentPersistedId: string | null;
  // EXISTS sub-filter support: set ONLY on a sub-filter tree's ROOT group (mirrors load's
  // mapExistsSubFilters, and asx_owningcriterion is root-only). Nested sub-filter descendants use
  // parentPersistedId like any nested group, but never carry this.
  owningCriterionId: string | null;
  // true for a group inside an exists node's `sub` tree (root or nested): these groups persist
  // WITHOUT filterGroupCondition/filterGroupConditionGroup/filterGroupTargetNode binds, since
  // they're evaluated against the criterion's collection node, not a condition's target.
  isSubFilter: boolean;
}
interface PersistedFilterCriterion {
  persistedId: string;
  /** Row version carried over from the model node, for the update's If-Match (see UpdateOp.etag). */
  etag: string | null;
  groupPersistedId: string;
  // true for the EXISTS criterion itself (asx_criteriontype = 2). false for an ordinary scalar
  // leaf (comparison criterion, including scalar leaves inside an exists node's sub-filter).
  isExists: boolean;
  // Scalar (comparison) fields, meaningful when !isExists.
  column: string | null;
  operator: number | null;
  valueSource: number;
  value: string | null;
  valueNodeId: string | null;
  valueColumn: string | null;
  // Exists fields, meaningful when isExists.
  collectionNodeId: string | null;
  minCount: number | null;
  maxCount: number | null;
}

// A condition with no filter blocks (or only empty ones) persists nothing.
function normalizeFilter(blocks: NodeFilterBlock[] | null | undefined): NodeFilterBlock[] | null {
  if (!blocks || blocks.length === 0) return null;
  const nonEmpty = blocks.filter((b) => !isBlockEmpty(b));
  return nonEmpty.length ? nonEmpty : null;
}

// Flattens a condition's NodeFilterBlock[] into the (group, criterion) records persisted as
// asx_nodefiltergroup / asx_nodefiltercriterion rows, the INVERSE of load/mappers.ts's
// mapNodeFilterTrees, centralized here so load and save stay symmetric.
//
// Each block's root becomes one top-level asx_nodefiltergroup (no filterGroupParent bind,
// targetNodeId = block.targetNodeId), and nested child groups become asx_nodefiltergroup rows
// with filterGroupParent pointing at their parent's (real or temp) id, sharing the SAME
// block.targetNodeId (the engine ignores a nested group's target and evaluates the whole tree
// against the top-level group's node, but every row still carries the block's target so a
// mid-tree row is never left null).
function scalarCriterion(leaf: NodeFilterLeaf, groupPersistedId: string): PersistedFilterCriterion {
  return {
    persistedId: leaf.id, etag: leaf.etag ?? null, groupPersistedId, isExists: false,
    column: leaf.column, operator: leaf.operator, valueSource: leaf.valueSource,
    value: leaf.value, valueNodeId: leaf.valueNodeId, valueColumn: leaf.valueColumn,
    collectionNodeId: null, minCount: null, maxCount: null,
  };
}

// `keepIncompleteLeaves` is for the DELETE path only (nodeFilterDeleteOps): on save an
// incomplete leaf must never be written, but on delete the question is not "should this row
// exist" but "does a row with this id exist in Dataverse", and a graph loaded from an org can
// carry rows a REST/ISV author wrote that the editor would never have created.
function flattenFilterBlocks(blocks: NodeFilterBlock[] | null, opts?: { keepIncompleteLeaves?: boolean }): {
  groups: PersistedFilterGroup[]; criteria: PersistedFilterCriterion[];
} {
  const keepAll = opts?.keepIncompleteLeaves === true;
  const groups: PersistedFilterGroup[] = [];
  const criteria: PersistedFilterCriterion[] = [];
  if (!blocks) return { groups, criteria };

  // Walks an exists node's `sub` tree, owned by the CRITERION (root-only), never by a condition.
  // Scalar-only, one level of nesting (AND/OR groups) allowed; never another "exists" (the model
  // guarantees sub is scalar-only, per nodeFilter.ts's NodeFilterExists doc comment).
  const walkSubFilter = (node: NodeFilterGroupModel, parentPersistedId: string | null, owningCriterionId: string | null) => {
    groups.push({
      persistedId: node.id, etag: node.etag ?? null, op: node.op, targetNodeId: null,
      parentPersistedId, owningCriterionId, isSubFilter: true,
    });
    for (const r of node.rules) {
      if (r.kind === "group") {
        walkSubFilter(r, node.id, null);
      } else if (r.kind === "rule" && (keepAll || isLeafComplete(r))) {
        criteria.push(scalarCriterion(r, node.id)); // incomplete leaves are dropped (see walk())
      }
    }
  };

  for (const block of blocks) {
    const walk = (node: NodeFilterGroupModel, parentPersistedId: string | null) => {
      groups.push({
        persistedId: node.id, etag: node.etag ?? null, op: node.op, targetNodeId: block.targetNodeId,
        parentPersistedId, owningCriterionId: null, isSubFilter: false,
      });
      for (const r of node.rules) {
        if (r.kind === "group") {
          walk(r, node.id);
        } else if (r.kind === "rule") {
          // INCOMPLETE LEAVES ARE NOT PERSISTED. Every filter block is seeded with one blank leaf
          // (emptyBlock -> emptyGroup -> [emptyLeaf()]) and Add appends more, so a half-finished
          // row is the NORMAL intermediate state of this editor. A criterion row with a null
          // column/operator is NOT inert downstream: NodeFilterEvaluator throws "Node filter
          // criterion has no operator configured." on the next write to the table, so
          // persisting one lets a rule validate clean, publish, and then block every save
          // (pinned by e2e/nodeFilterUi.e2e.spec.ts). isLeafComplete is the SAME predicate the
          // inspector's
          // "N conditions" summary counts with, so what the author is shown is what is written.
          if (keepAll || isLeafComplete(r)) criteria.push(scalarCriterion(r, node.id));
        } else if (r.kind === "exists") {
          criteria.push({
            persistedId: r.id, etag: r.etag ?? null, groupPersistedId: node.id, isExists: true,
            column: null, operator: null, valueSource: 1, value: null, valueNodeId: null, valueColumn: null,
            collectionNodeId: r.collectionNodeId, minCount: r.minCount, maxCount: r.maxCount,
          });
          walkSubFilter(r.sub, null, r.id);
        }
      }
    };
    walk(block.root, null);
  }
  return { groups, criteria };
}

function filterGroupAttrs(g: PersistedFilterGroup): Record<string, any> {
  return { asx_logicaloperator: g.op === "or" ? 2 : 1 };
}
function filterCriterionAttrs(c: PersistedFilterCriterion): Record<string, any> {
  if (c.isExists) {
    return {
      asx_criteriontype: 2,
      asx_mincount: c.minCount,
      asx_maxcount: c.maxCount,
    };
  }
  return {
    asx_fieldname: c.column,
    asx_operator: c.operator == null ? null : operatorToFetchOp(c.operator).op,
    asx_value: c.value,
    asx_comparisonvaluesource: c.valueSource,
    asx_comparisonvaluecolumn: c.valueColumn,
  };
}

function filterGroupBindChanges(prev: PersistedFilterGroup, next: PersistedFilterGroup): Bind[] {
  const out: Bind[] = [];
  if (next.targetNodeId && next.targetNodeId !== prev.targetNodeId)
    out.push({ navProp: BIND_NAV.filterGroupTargetNode, targetSet: ENTITY_SET.tableConfig, ref: ref(next.targetNodeId) });
  if (next.parentPersistedId && next.parentPersistedId !== prev.parentPersistedId)
    out.push({ navProp: BIND_NAV.filterGroupParent, targetSet: ENTITY_SET.nodeFilterGroup, ref: ref(next.parentPersistedId) });
  if (next.owningCriterionId && next.owningCriterionId !== prev.owningCriterionId)
    out.push({ navProp: BIND_NAV.filterGroupOwningCriterion, targetSet: ENTITY_SET.nodeFilterCriterion, ref: ref(next.owningCriterionId) });
  return out;
}
function filterCriterionBindChanges(prev: PersistedFilterCriterion, next: PersistedFilterCriterion): Bind[] {
  const out: Bind[] = [];
  if (next.groupPersistedId !== prev.groupPersistedId)
    out.push({ navProp: BIND_NAV.filterCriterionGroup, targetSet: ENTITY_SET.nodeFilterGroup, ref: ref(next.groupPersistedId) });
  if (next.valueSource === 2 && next.valueNodeId && next.valueNodeId !== prev.valueNodeId)
    out.push({ navProp: BIND_NAV.filterCriterionValueNode, targetSet: ENTITY_SET.tableConfig, ref: ref(next.valueNodeId) });
  if (next.collectionNodeId && next.collectionNodeId !== prev.collectionNodeId)
    out.push({ navProp: BIND_NAV.filterCriterionCollectionNode, targetSet: ENTITY_SET.tableConfig, ref: ref(next.collectionNodeId) });
  return out;
}

// Unified dependency depth across a condition's flattened filter groups + criteria, used to
// order DELETES so a referencer is always removed before the record it references (the mirror-
// reverse of the create dependency chain below). A sub-filter ROOT group depends on (references)
// its owning exists criterion; any criterion depends on its containing group; a nested group
// depends on its parent group. `seen` guards against cycles (not expected, but keeps this total).
function filterDeleteDepth(
  groups: PersistedFilterGroup[], criteria: PersistedFilterCriterion[],
  entity: "group" | "criterion", id: string,
): number {
  const groupById = new Map(groups.map((g) => [g.persistedId, g]));
  const critById = new Map(criteria.map((c) => [c.persistedId, c]));
  const groupDepth = (gid: string, seen: Set<string>): number => {
    if (seen.has(gid)) return 0;
    seen.add(gid);
    const g = groupById.get(gid);
    if (!g) return 0;
    if (g.owningCriterionId && critById.has(g.owningCriterionId)) return critDepth(g.owningCriterionId, seen) + 1;
    if (g.parentPersistedId && groupById.has(g.parentPersistedId)) return groupDepth(g.parentPersistedId, seen) + 1;
    return 0;
  };
  const critDepth = (cid: string, seen: Set<string>): number => {
    const c = critById.get(cid);
    if (!c) return 0;
    return groupDepth(c.groupPersistedId, seen) + 1;
  };
  return entity === "group" ? groupDepth(id, new Set()) : critDepth(id, new Set());
}

// ---- Reclaiming a condition's filter rows on delete ----
// Deleting an asx_rulecondition does NOT cascade to the asx_nodefiltergroup /
// asx_nodefiltercriterion rows it owns: `asx_rulecondition_nodefiltergroup` is a plain 1:N
// (docs/Schema.md section 7), which is what the per-condition diff branch below relies on and why
// e2e/devHelpers.ts's deleteRuleCascade reclaims them by hand. A rule delete must therefore emit
// these explicitly or every filter row it owned is orphaned.
//
// Order mirrors diffRuleGraph's own filter-delete buckets exactly: scalar (non-exists) criteria
// first (they are pure leaves nothing references), then filter GROUPS and EXISTS criteria in one
// bucket sorted deepest-first, so a sub-filter root group is deleted before the criterion its
// asx_owningcriterion points at.
//
// Temp-id rows are skipped: they have no Dataverse row to delete (load's emptyLoadedSubFilter
// synthesises one for an exists node whose sub-filter did not come back).
export function nodeFilterDeleteOps(blocks: NodeFilterBlock[] | null | undefined): DeleteOp[] {
  const { groups, criteria } = flattenFilterBlocks(blocks ?? null, { keepIncompleteLeaves: true });
  const del = (entity: string, set: string, id: string): DeleteOp => ({ kind: "delete", entity, set, id });
  const scalar = criteria
    .filter((c) => !c.isExists && !isNewId(c.persistedId))
    .map((c) => del(ENTITY.nodeFilterCriterion, ENTITY_SET.nodeFilterCriterion, c.persistedId));
  const structural = [
    ...groups
      .filter((g) => !isNewId(g.persistedId))
      .map((g) => ({ op: del(ENTITY.nodeFilterGroup, ENTITY_SET.nodeFilterGroup, g.persistedId),
        depth: filterDeleteDepth(groups, criteria, "group", g.persistedId) })),
    ...criteria
      .filter((c) => c.isExists && !isNewId(c.persistedId))
      .map((c) => ({ op: del(ENTITY.nodeFilterCriterion, ENTITY_SET.nodeFilterCriterion, c.persistedId),
        depth: filterDeleteDepth(groups, criteria, "criterion", c.persistedId) })),
  ].sort((a, b) => b.depth - a.depth).map((x) => x.op);
  return [...scalar, ...structural];
}

// Unified topological sort over ALL of a condition's filter-group + filter-criterion creates.
// Dependencies (a create must follow every create it references via a NEW-id bind):
//   filterGroupParent            (nested group -> its parent group)
//   filterGroupOwningCriterion   (sub-filter ROOT group -> its owning exists criterion)
//   filterCriterionGroup         (any criterion -> its containing group)
// This subsumes the old "all groups, then all criteria" split (which cannot express "exists
// criterion before its own sub-root group") and is robust to arbitrary sub-nesting.
const FILTER_CREATE_DEP_NAV_PROPS: readonly string[] = [
  BIND_NAV.filterGroupParent, BIND_NAV.filterGroupOwningCriterion, BIND_NAV.filterCriterionGroup,
];
function topoFilterCreates(filterCreates: CreateOp[]): CreateOp[] {
  const byTemp = new Map(filterCreates.map((o) => [o.tempId, o]));
  const emitted = new Set<string>();
  const out: CreateOp[] = [];
  const visit = (op: CreateOp) => {
    if (emitted.has(op.tempId)) return;
    emitted.add(op.tempId);
    for (const bind of op.binds) {
      if (FILTER_CREATE_DEP_NAV_PROPS.includes(bind.navProp) && bind.ref.kind === "new" && byTemp.has(bind.ref.tempId)) {
        visit(byTemp.get(bind.ref.tempId)!);
      }
    }
    out.push(op);
  };
  filterCreates.forEach(visit);
  return out;
}

export function diffRuleGraph(snapshot: RuleGraph, working: RuleGraph): Operation[] {
  const creates: CreateOp[] = [];
  const updates: UpdateOp[] = [];
  const deletes: Array<DeleteOp & { _depth?: number; _structural?: boolean }> = [];

  // ---- Rule (always exists) ----
  const ruleAttrs = (r: RuleGraph["rule"]): Record<string, any> => ({
    asx_name: r.name,
    asx_triggers: encodeMultiSelect(r.triggers),
    asx_channels: encodeMultiSelect(r.channels),
    asx_effectivefrom: r.effectiveFrom,
    asx_effectiveto: r.effectiveTo,
    asx_evaluationcontext: r.evaluationContext,
    asx_triggercolumns: r.triggerColumns.length ? JSON.stringify(r.triggerColumns) : null,
  });
  const ruleChanged = changedAttrs(ruleAttrs(snapshot.rule), ruleAttrs(working.rule));
  const ruleBinds: Bind[] = [];
  // NOTE: the rule update is emitted first in the op array, so this root bind must
  // reference an EXISTING node (full URL), never a $N Content-ID. Safe today because
  // the editor only sets the root to an existing RootTable node (addNode never creates
  // roots). If new-root provisioning is ever added, move this bind after the node
  // creates or emit it as a trailing rule update.
  if (working.rule.rootTableConfigId && working.rule.rootTableConfigId !== snapshot.rule.rootTableConfigId)
    ruleBinds.push({ navProp: BIND_NAV.ruleRootTableConfig, targetSet: ENTITY_SET.tableConfig, ref: ref(working.rule.rootTableConfigId) });
  if (Object.keys(ruleChanged).length > 0 || ruleBinds.length > 0) {
    updates.push({
      kind: "update", entity: ENTITY.rule, set: ENTITY_SET.rule, id: working.rule.id,
      attrs: ruleChanged, binds: ruleBinds, etag: working.rule.etag,
    });
  }

  // ---- Groups ----
  const snapGroups = flattenGroups([...snapshot.executionGroups, ...snapshot.validationGroups]);
  const workGroups = flattenGroups([...working.executionGroups, ...working.validationGroups]);
  const snapGroupById = new Map(snapGroups.map((x) => [x.group.id, x]));
  const workGroupIds = new Set(workGroups.map((x) => x.group.id));

  for (const { group, parentId } of workGroups) {
    const binds: Bind[] = [
      { navProp: BIND_NAV.groupRule, targetSet: ENTITY_SET.rule, ref: { kind: "existing", id: working.rule.id } },
    ];
    if (parentId) binds.push({ navProp: BIND_NAV.groupParent, targetSet: ENTITY_SET.group, ref: ref(parentId) });
    if (isNewId(group.id)) {
      creates.push({ kind: "create", entity: ENTITY.group, set: ENTITY_SET.group, tempId: group.id, attrs: groupAttrs(group), binds });
    } else {
      const prev = snapGroupById.get(group.id);
      const attrs = prev ? changedAttrs(groupAttrs(prev.group), groupAttrs(group)) : groupAttrs(group);
      if (Object.keys(attrs).length > 0) {
        updates.push({ kind: "update", entity: ENTITY.group, set: ENTITY_SET.group, id: group.id, attrs, binds: [], etag: etagOf(prev?.group) });
      }
    }
  }
  for (const { group } of snapGroups) {
    if (!workGroupIds.has(group.id)) {
      deletes.push({ kind: "delete", entity: ENTITY.group, set: ENTITY_SET.group, id: group.id, _depth: groupDepth(snapGroups, group.id) });
    }
  }

  // ---- Table-config nodes ----
  const snapNodes = snapshot.tableConfigs;
  const workNodes = working.tableConfigs;
  for (const node of Object.values(workNodes)) {
    const binds: Bind[] = [];
    if (node.parentTableConfigId)
      binds.push({ navProp: BIND_NAV.tableConfigParent, targetSet: ENTITY_SET.tableConfig, ref: ref(node.parentTableConfigId) });
    if (isNewId(node.id)) {
      creates.push({ kind: "create", entity: ENTITY.tableConfig, set: ENTITY_SET.tableConfig, tempId: node.id, attrs: tableConfigAttrs(node), binds });
    } else {
      const prev = snapNodes[node.id];
      const attrs = prev ? changedAttrs(tableConfigAttrs(prev), tableConfigAttrs(node)) : tableConfigAttrs(node);
      if (Object.keys(attrs).length > 0) {
        updates.push({ kind: "update", entity: ENTITY.tableConfig, set: ENTITY_SET.tableConfig, id: node.id, attrs, binds: [], etag: etagOf(prev) });
      }
    }
  }
  for (const id of Object.keys(snapNodes)) {
    if (!workNodes[id]) {
      deletes.push({ kind: "delete", entity: ENTITY.tableConfig, set: ENTITY_SET.tableConfig, id,
        _depth: tableConfigDepth(snapNodes, id) });
    }
  }

  // ---- Conditions ----
  const snapConds = flattenConditions([...snapshot.executionGroups, ...snapshot.validationGroups]);
  const workConds = flattenConditions([...working.executionGroups, ...working.validationGroups]);
  const snapCondById = new Map(snapConds.map((x) => [x.condition.id, x]));
  const workCondIds = new Set(workConds.map((x) => x.condition.id));

  for (const { condition, groupId } of workConds) {
    const binds: Bind[] = [
      { navProp: BIND_NAV.conditionGroup, targetSet: ENTITY_SET.group, ref: ref(groupId) },
    ];
    if (condition.tableConfigId) binds.push({ navProp: BIND_NAV.conditionTableConfig, targetSet: ENTITY_SET.tableConfig, ref: ref(condition.tableConfigId) });
    if (condition.comparisonValueNodeId) binds.push({ navProp: BIND_NAV.conditionValueNode, targetSet: ENTITY_SET.tableConfig, ref: ref(condition.comparisonValueNodeId) });
    if (isNewId(condition.id)) {
      creates.push({ kind: "create", entity: ENTITY.condition, set: ENTITY_SET.condition, tempId: condition.id, attrs: conditionAttrs(condition), binds });
    } else {
      const prev = snapCondById.get(condition.id);
      const attrs = prev ? changedAttrs(conditionAttrs(prev.condition), conditionAttrs(condition)) : conditionAttrs(condition);
      const changedBinds = prev ? condBindChanges(prev.condition, condition) : binds;
      if (Object.keys(attrs).length > 0 || changedBinds.length > 0) {
        updates.push({ kind: "update", entity: ENTITY.condition, set: ENTITY_SET.condition, id: condition.id, attrs, binds: changedBinds, etag: etagOf(prev?.condition) });
      }
    }
  }
  for (const { condition } of snapConds) {
    if (!workCondIds.has(condition.id)) {
      deletes.push({ kind: "delete", entity: ENTITY.condition, set: ENTITY_SET.condition, id: condition.id });
    }
  }

  // ---- Actions ----
  const snapActById = new Map(snapshot.actions.map((a) => [a.id, a]));
  const workActIds = new Set(working.actions.map((a) => a.id));
  for (const a of working.actions) {
    const binds: Bind[] = [
      { navProp: BIND_NAV.actionRule, targetSet: ENTITY_SET.rule, ref: { kind: "existing", id: working.rule.id } },
    ];
    if (a.targetNodeId) binds.push({ navProp: BIND_NAV.actionTargetNode, targetSet: ENTITY_SET.tableConfig, ref: ref(a.targetNodeId) });
    if (isNewId(a.id)) {
      creates.push({ kind: "create", entity: ENTITY.action, set: ENTITY_SET.action, tempId: a.id, attrs: actionAttrs(a), binds });
    } else {
      const prev = snapActById.get(a.id);
      const attrs = prev ? changedAttrs(actionAttrs(prev), actionAttrs(a)) : actionAttrs(a);
      const changedBinds = prev ? actionBindChanges(prev, a) : binds;
      if (Object.keys(attrs).length > 0 || changedBinds.length > 0) {
        updates.push({ kind: "update", entity: ENTITY.action, set: ENTITY_SET.action, id: a.id, attrs, binds: changedBinds, etag: etagOf(prev) });
      }
    }

    // localized-message children for this action
    const prevMsgs = isNewId(a.id) ? [] : (snapActById.get(a.id)?.localizedMessages ?? []);
    const prevById = new Map(prevMsgs.map((m) => [m.id, m]));
    const workIds = new Set(a.localizedMessages.map((m) => m.id));
    for (const m of a.localizedMessages) {
      const binds: Bind[] = [
        { navProp: BIND_NAV.localizedMessageAction, targetSet: ENTITY_SET.localizedMessage, ref: ref(a.id) },
      ];
      if (isNewId(m.id)) {
        creates.push({ kind: "create", entity: ENTITY.localizedMessage, set: ENTITY_SET.localizedMessage,
          tempId: m.id, attrs: localizedAttrs(m), binds });
      } else {
        const prev = prevById.get(m.id);
        const attrs = prev ? changedAttrs(localizedAttrs(prev), localizedAttrs(m)) : localizedAttrs(m);
        if (Object.keys(attrs).length > 0) {
          updates.push({ kind: "update", entity: ENTITY.localizedMessage, set: ENTITY_SET.localizedMessage,
            id: m.id, attrs, binds: [], etag: etagOf(prev) });
        }
      }
    }
    for (const m of prevMsgs) {
      if (!workIds.has(m.id)) {
        deletes.push({ kind: "delete", entity: ENTITY.localizedMessage, set: ENTITY_SET.localizedMessage, id: m.id });
      }
    }
  }
  for (const a of snapshot.actions) {
    if (!workActIds.has(a.id)) {
      deletes.push({ kind: "delete", entity: ENTITY.action, set: ENTITY_SET.action, id: a.id });
    }
  }

  // ---- Node filters ----
  // Diffed per-condition (union of snapshot + working condition ids) so a removed condition's
  // filter records are deleted too: deleting the asx_rulecondition row does not cascade.
  const workCondById = new Map(workConds.map((x) => [x.condition.id, x]));
  const allFilterCondIds = new Set([...snapCondById.keys(), ...workCondById.keys()]);
  for (const condId of allFilterCondIds) {
    const snapEntry = snapCondById.get(condId);
    const workEntry = workCondById.get(condId);
    const snapBlocks = normalizeFilter(snapEntry?.condition.filter);
    const workBlocks = normalizeFilter(workEntry?.condition.filter);
    if (!snapBlocks && !workBlocks) continue;

    const { groups: fgSnapGroups, criteria: fgSnapCriteria } = flattenFilterBlocks(snapBlocks);
    const { groups: fgWorkGroups, criteria: fgWorkCriteria } = flattenFilterBlocks(workBlocks);
    const snapGroupById = new Map(fgSnapGroups.map((g) => [g.persistedId, g]));
    const workGroupIds = new Set(fgWorkGroups.map((g) => g.persistedId));
    const snapCritById = new Map(fgSnapCriteria.map((c) => [c.persistedId, c]));
    const workCritIds = new Set(fgWorkCriteria.map((c) => c.persistedId));

    for (const g of fgWorkGroups) {
      // Sub-filter groups (an exists node's `sub` tree) are owned by their criterion, NOT the
      // condition: they never carry filterGroupCondition/filterGroupConditionGroup/
      // filterGroupTargetNode. Only the sub-tree ROOT carries filterGroupOwningCriterion; nested
      // sub-groups link via filterGroupParent like any nested group.
      const binds: Bind[] = [];
      if (g.isSubFilter) {
        if (g.owningCriterionId) binds.push({ navProp: BIND_NAV.filterGroupOwningCriterion, targetSet: ENTITY_SET.nodeFilterCriterion, ref: ref(g.owningCriterionId) });
        if (g.parentPersistedId) binds.push({ navProp: BIND_NAV.filterGroupParent, targetSet: ENTITY_SET.nodeFilterGroup, ref: ref(g.parentPersistedId) });
      } else {
        binds.push(
          { navProp: BIND_NAV.filterGroupCondition, targetSet: ENTITY_SET.condition, ref: ref(condId) },
          { navProp: BIND_NAV.filterGroupConditionGroup, targetSet: ENTITY_SET.group, ref: ref(workEntry!.groupId) },
        );
        if (g.targetNodeId) binds.push({ navProp: BIND_NAV.filterGroupTargetNode, targetSet: ENTITY_SET.tableConfig, ref: ref(g.targetNodeId) });
        if (g.parentPersistedId) binds.push({ navProp: BIND_NAV.filterGroupParent, targetSet: ENTITY_SET.nodeFilterGroup, ref: ref(g.parentPersistedId) });
      }

      if (isNewId(g.persistedId)) {
        creates.push({ kind: "create", entity: ENTITY.nodeFilterGroup, set: ENTITY_SET.nodeFilterGroup, tempId: g.persistedId, attrs: filterGroupAttrs(g), binds });
      } else {
        const prev = snapGroupById.get(g.persistedId);
        const attrs = prev ? changedAttrs(filterGroupAttrs(prev), filterGroupAttrs(g)) : filterGroupAttrs(g);
        const bindChanges = prev ? filterGroupBindChanges(prev, g) : binds;
        if (Object.keys(attrs).length > 0 || bindChanges.length > 0) {
          updates.push({ kind: "update", entity: ENTITY.nodeFilterGroup, set: ENTITY_SET.nodeFilterGroup, id: g.persistedId, attrs, binds: bindChanges, etag: etagOf(prev) });
        }
      }
    }
    for (const g of fgSnapGroups) {
      if (!workGroupIds.has(g.persistedId)) {
        deletes.push({ kind: "delete", entity: ENTITY.nodeFilterGroup, set: ENTITY_SET.nodeFilterGroup, id: g.persistedId,
          _depth: filterDeleteDepth(fgSnapGroups, fgSnapCriteria, "group", g.persistedId) });
      }
    }

    for (const c of fgWorkCriteria) {
      const binds: Bind[] = [
        { navProp: BIND_NAV.filterCriterionGroup, targetSet: ENTITY_SET.nodeFilterGroup, ref: ref(c.groupPersistedId) },
      ];
      if (c.isExists) {
        if (c.collectionNodeId) binds.push({ navProp: BIND_NAV.filterCriterionCollectionNode, targetSet: ENTITY_SET.tableConfig, ref: ref(c.collectionNodeId) });
      } else if (c.valueSource === 2 && c.valueNodeId) {
        binds.push({ navProp: BIND_NAV.filterCriterionValueNode, targetSet: ENTITY_SET.tableConfig, ref: ref(c.valueNodeId) });
      }
      if (isNewId(c.persistedId)) {
        creates.push({ kind: "create", entity: ENTITY.nodeFilterCriterion, set: ENTITY_SET.nodeFilterCriterion, tempId: c.persistedId, attrs: filterCriterionAttrs(c), binds });
      } else {
        const prev = snapCritById.get(c.persistedId);
        const attrs = prev ? changedAttrs(filterCriterionAttrs(prev), filterCriterionAttrs(c)) : filterCriterionAttrs(c);
        const bindChanges = prev ? filterCriterionBindChanges(prev, c) : binds;
        if (Object.keys(attrs).length > 0 || bindChanges.length > 0) {
          updates.push({ kind: "update", entity: ENTITY.nodeFilterCriterion, set: ENTITY_SET.nodeFilterCriterion, id: c.persistedId, attrs, binds: bindChanges, etag: etagOf(prev) });
        }
      }
    }
    for (const c of fgSnapCriteria) {
      if (!workCritIds.has(c.persistedId)) {
        // Exists criteria are "structural" for delete ordering: a sub-root group's
        // owningcriterion FK means the criterion must be deleted AFTER its owned sub-groups, so
        // it can't unconditionally join the (always-safe-first) scalar-criterion bucket below.
        deletes.push({ kind: "delete", entity: ENTITY.nodeFilterCriterion, set: ENTITY_SET.nodeFilterCriterion, id: c.persistedId,
          _depth: filterDeleteDepth(fgSnapGroups, fgSnapCriteria, "criterion", c.persistedId),
          _structural: c.isExists });
      }
    }
  }

  // ---- Ordering ----
  const ruleUpdate = updates.filter((o) => o.entity === ENTITY.rule);
  const otherUpdates = updates.filter((o) => o.entity !== ENTITY.rule);
  const groupCreates = topoGroupCreates(creates.filter((o) => o.entity === ENTITY.group));
  const nodeCreates = topoTableConfigCreates(creates.filter((o) => o.entity === ENTITY.tableConfig));
  const condCreates = creates.filter((o) => o.entity === ENTITY.condition);
  const filterCreates = topoFilterCreates(creates.filter((o) => o.entity === ENTITY.nodeFilterGroup || o.entity === ENTITY.nodeFilterCriterion));
  const actionCreatesOnly = creates.filter((o) => o.entity === ENTITY.action);
  const localizedCreates = creates.filter((o) => o.entity === ENTITY.localizedMessage);
  const condDeletes = deletes.filter((o) => o.entity === ENTITY.condition);
  const groupDeletes = deletes.filter((o) => o.entity === ENTITY.group)
    .sort((a, b) => (b._depth ?? 0) - (a._depth ?? 0))
    .map(({ _depth, ...o }) => o as DeleteOp);
  const nodeDeletes = deletes.filter((o) => o.entity === ENTITY.tableConfig)
    .sort((a, b) => (b._depth ?? 0) - (a._depth ?? 0)).map(({ _depth, ...o }) => o as DeleteOp);
  // Filter-criterion deletes split in two: ordinary (non-exists) scalar criteria are pure leaves
  // in the dependency graph: nothing ever references them, so they're always safe to delete
  // first, regardless of tree shape. Exists criteria are "structural" (a sub-root group
  // references them via owningcriterion), so they're merged into the SAME depth-ordered bucket
  // as filter-group deletes: the two-bucket "all criteria, then all groups" split can't express
  // "exists criterion after its owned sub-groups" (see filterDeleteDepth above).
  const filterCriterionDeletesAll = deletes.filter((o) => o.entity === ENTITY.nodeFilterCriterion);
  const scalarFilterCriterionDeletes = filterCriterionDeletesAll
    .filter((o) => !o._structural)
    .map(({ _depth, _structural, ...o }) => o as DeleteOp);
  const structuralFilterDeletes = ([
    ...deletes.filter((o) => o.entity === ENTITY.nodeFilterGroup),
    ...filterCriterionDeletesAll.filter((o) => o._structural),
  ])
    .sort((a, b) => (b._depth ?? 0) - (a._depth ?? 0))
    .map(({ _depth, _structural, ...o }) => o as DeleteOp);
  const actionDeletes = deletes.filter((o) => o.entity === ENTITY.action);
  const localizedDeletes = deletes.filter((o) => o.entity === ENTITY.localizedMessage);

  return [
    ...ruleUpdate, ...nodeCreates, ...groupCreates, ...condCreates,
    ...filterCreates,
    ...actionCreatesOnly, ...localizedCreates,
    ...otherUpdates,
    ...scalarFilterCriterionDeletes, ...structuralFilterDeletes,
    ...condDeletes, ...groupDeletes, ...nodeDeletes, ...actionDeletes, ...localizedDeletes,
  ];
}

function condBindChanges(prev: ConditionNode, next: ConditionNode): Bind[] {
  const out: Bind[] = [];
  if (next.tableConfigId && next.tableConfigId !== prev.tableConfigId)
    out.push({ navProp: BIND_NAV.conditionTableConfig, targetSet: ENTITY_SET.tableConfig, ref: ref(next.tableConfigId) });
  if (next.comparisonValueNodeId && next.comparisonValueNodeId !== prev.comparisonValueNodeId)
    out.push({ navProp: BIND_NAV.conditionValueNode, targetSet: ENTITY_SET.tableConfig, ref: ref(next.comparisonValueNodeId) });
  return out;
}
function actionBindChanges(prev: ActionNode, next: ActionNode): Bind[] {
  const out: Bind[] = [];
  if (next.targetNodeId && next.targetNodeId !== prev.targetNodeId)
    out.push({ navProp: BIND_NAV.actionTargetNode, targetSet: ENTITY_SET.tableConfig, ref: ref(next.targetNodeId) });
  return out;
}

// New parent groups must precede new child groups (lower Content-ID).
function topoGroupCreates(groupCreates: CreateOp[]): CreateOp[] {
  const byTemp = new Map(groupCreates.map((o) => [o.tempId, o]));
  const emitted = new Set<string>();
  const out: CreateOp[] = [];
  const visit = (op: CreateOp) => {
    if (emitted.has(op.tempId)) return;
    const parentBind = op.binds.find((b) => b.navProp === BIND_NAV.groupParent);
    if (parentBind && parentBind.ref.kind === "new" && byTemp.has(parentBind.ref.tempId)) {
      visit(byTemp.get(parentBind.ref.tempId)!);
    }
    emitted.add(op.tempId);
    out.push(op);
  };
  groupCreates.forEach(visit);
  return out;
}

function groupDepth(snapGroups: { group: ConditionGroupNode; parentId: string | null }[], id: string): number {
  const byId = new Map(snapGroups.map((x) => [x.group.id, x]));
  let depth = 0;
  let cur = byId.get(id);
  while (cur && cur.parentId && byId.has(cur.parentId)) {
    depth += 1;
    cur = byId.get(cur.parentId);
  }
  return depth;
}

function tableConfigDepth(nodes: Record<string, import("../model/types").TableConfigRef>, id: string): number {
  let depth = 0; let cur = nodes[id]?.parentTableConfigId ?? null; const seen = new Set<string>();
  while (cur && nodes[cur] && !seen.has(cur)) { seen.add(cur); depth += 1; cur = nodes[cur].parentTableConfigId; }
  return depth;
}

// New parent nodes must precede new child nodes (lower Content-ID).
function topoTableConfigCreates(nodeCreates: CreateOp[]): CreateOp[] {
  const byTemp = new Map(nodeCreates.map((o) => [o.tempId, o]));
  const emitted = new Set<string>(); const out: CreateOp[] = [];
  const visit = (op: CreateOp) => {
    if (emitted.has(op.tempId)) return;
    const parentBind = op.binds.find((b) => b.navProp === BIND_NAV.tableConfigParent);
    if (parentBind && parentBind.ref.kind === "new" && byTemp.has(parentBind.ref.tempId)) visit(byTemp.get(parentBind.ref.tempId)!);
    emitted.add(op.tempId); out.push(op);
  };
  nodeCreates.forEach(visit);
  return out;
}
