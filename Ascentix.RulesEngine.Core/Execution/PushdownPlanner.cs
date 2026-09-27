using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>Per-evaluation pushdown decisions: which cache variant each condition reads.</summary>
    public class PushdownPlan
    {
        /// <summary>conditionId → variant key on the condition's own node. Absent ⇒ the
        /// condition reads the unfiltered entry (unchanged legacy behavior).</summary>
        public Dictionary<Guid, string> ConditionVariantKeys { get; } = new Dictionary<Guid, string>();
    }

    /// <summary>
    /// Computes pushdown variants and the unfiltered-demand proof, then attaches both to the
    /// query plan (phase 1: self-targeting literal filters and RowCount search criteria).
    ///
    /// Demand proof: a node's UNFILTERED fetch is skipped only when nothing consumes it, meaning
    /// no planned child reads its ids, no hard reader (the rule reference set's
    /// <c>HardReaders</c>: write targets, mapping/template/mathexpr/dateexpr/message refs)
    /// touches it, no condition RHS references it, no filter reads it other than as the
    /// self-target of a condition it owns, and every condition targeting it evaluates through a
    /// pushed variant (a superset-returning relaxation; the full filter re-applies in memory).
    /// That proof is what lets a rule touch a multi-million-row collection without
    /// materializing it.
    /// </summary>
    public static class PushdownPlanner
    {
        public static PushdownPlan Apply(
            QueryExecutionPlan plan,
            TableConfigTree tree,
            List<ConditionGroup> rootGroups,
            IEnumerable<Guid> hardReaderNodeIds)
            => Apply(plan, tree, rootGroups, hardReaderNodeIds, null);

        /// <param name="hardReaderNodeIds">The reference set's hard readers: always demanded unfiltered.</param>
        /// <param name="filterDerivedNodeIds">The reference set's filter-derived nodes (filter targets,
        /// filter value nodes, EXISTS collections, sub-filter nodes). Every one of them is demanded
        /// unfiltered EXCEPT a filter target that is only ever the self-target of a condition owning
        /// the filter, because that read is served by the condition's pushed variant. The planner's
        /// own walk below classifies each occurrence; this set is the safety net that keeps the proof
        /// and the reference set in agreement if either gains a kind.</param>
        /// <param name="utcNow">The run's evaluation instant, for "now"-anchored date filters.</param>
        /// <param name="kinds">Date column behaviors (metadata). Null ⇒ unknown: date values push
        /// widened, ranges only.</param>
        /// <param name="zonesByRule">Each rule's evaluation time zone (null ⇒ UTC for every rule).
        /// A rule missing from a supplied map has no date semantics in memory, so its date values
        /// push as if the behavior were unknown.</param>
        public static PushdownPlan Apply(
            QueryExecutionPlan plan,
            TableConfigTree tree,
            List<ConditionGroup> rootGroups,
            IEnumerable<Guid> hardReaderNodeIds,
            IEnumerable<Guid> filterDerivedNodeIds,
            DateTime? utcNow = null,
            IDateColumnKindProvider kinds = null,
            IReadOnlyDictionary<Guid, TimeZoneInfo> zonesByRule = null)
        {
            var result = new PushdownPlan();
            var demand = new HashSet<Guid>(hardReaderNodeIds ?? Enumerable.Empty<Guid>());
            var variantsByNode = new Dictionary<Guid, Dictionary<string, NodeQueryVariant>>();

            // Ownership-independent demand over EVERY filter occurrence the rule reaches (the
            // runner plans from all of them, whoever owns them), so the plan and the proof agree
            // on exactly which nodes exist:
            //  - every criterion value node and EXISTS collection, INCLUDING those inside an EXISTS
            //    sub-filter (the sub-filter hangs off the criterion, not the ChildGroups chain,
            //    so a sub-filter value node that also carries a variant must not be skipped);
            //  - every filter TARGET that is not served by a self-filter variant: an ancestor-
            //    targeting filter, a filter owned by a condition outside its own group (planned,
            //    but no condition's pass ever demanded it, so EvaluateExists counted zero from an
            //    entry that was never populated), or a filter in a group with no
            //    condition on its node at all.
            var selfServedTargets = new HashSet<Guid>();
            foreach (var group in Flatten(rootGroups))
                foreach (var filter in FlattenFilterGroups(group.NodeFilterGroups))
                {
                    foreach (var id in CriterionNodeIds(filter)) demand.Add(id);

                    var target = filter.TableConfigNodeId;
                    if (target == Guid.Empty) continue;
                    var servedBySelf = (group.Conditions ?? new List<RuleCondition>()).Any(c =>
                        c.TableConfigNodeId == target
                        && (filter.RuleConditionId == null || filter.RuleConditionId == c.Id));
                    if (servedBySelf) selfServedTargets.Add(target);
                    else demand.Add(target);
                }

            foreach (var id in filterDerivedNodeIds ?? Enumerable.Empty<Guid>())
                if (!selfServedTargets.Contains(id)) demand.Add(id);

            foreach (var group in Flatten(rootGroups))
            {
                foreach (var condition in group.Conditions ?? new List<RuleCondition>())
                {
                    // RHS field-references read the referenced node's unfiltered rows.
                    if (condition.ComparisonValueNodeId.HasValue)
                        demand.Add(condition.ComparisonValueNodeId.Value);

                    // A rule missing from a supplied zone map has no date semantics in memory, so
                    // its date values push as if the behavior were unknown.
                    TimeZoneInfo zone = TimeZoneInfo.Utc;
                    var knownZone = zonesByRule == null || zonesByRule.TryGetValue(group.RuleId, out zone);
                    var translated = TranslateCondition(group, condition, tree, utcNow, knownZone ? kinds : null, zone);
                    if (translated == null)
                    {
                        demand.Add(condition.TableConfigNodeId); // plain unfiltered consumer
                        continue;
                    }
                    if (translated.Pushed == null)
                    {
                        demand.Add(condition.TableConfigNodeId); // nothing pushed: legacy path
                        continue;
                    }

                    // NOTE: a top-K probe optimization (truncate the fetch at K = min/max+1 for
                    // fully-pushed RowCounts) is UNSOUND here: pushed predicates are relaxations
                    // under server collation, and truncating before the in-memory re-application
                    // discards true matches beyond K. It would only be safe in a later phase,
                    // gated on metadata-proven exact predicates.
                    var key = translated.Pushed.CanonicalKey();
                    result.ConditionVariantKeys[condition.Id] = key;
                    if (!variantsByNode.TryGetValue(condition.TableConfigNodeId, out var byKey))
                        variantsByNode[condition.TableConfigNodeId] = byKey = new Dictionary<string, NodeQueryVariant>();
                    if (!byKey.ContainsKey(key))
                        byKey[key] = new NodeQueryVariant
                        {
                            Key = key,
                            Filter = translated.Pushed,
                            FilterFetchXml = translated.Pushed.HasBindings ? null : translated.Pushed.ToFetchXml(),
                        };
                    // Partial pushdown does NOT demand unfiltered: the variant is a superset and
                    // ApplyNodeFilters re-runs the full original filter over it.
                }
            }

            var entries = plan.Levels.SelectMany(l => l).ToList();
            var parentIds = new HashSet<Guid>(
                entries.Where(e => e.Node.ParentTableId.HasValue).Select(e => e.Node.ParentTableId.Value));

            foreach (var entry in entries)
            {
                if (variantsByNode.TryGetValue(entry.Node.Id, out var byKey))
                    entry.Variants = byKey.Values.ToList();
                entry.DemandsUnfiltered =
                    demand.Contains(entry.Node.Id) || parentIds.Contains(entry.Node.Id);

                // Invariant: a node IN the plan is a node someone reads. If the proof cannot name
                // a consumer and no variant covers it, the honest reading is that the proof missed
                // one, not that the node is free to skip. Skipping is unrecoverable (consumers
                // cannot tell an unfetched entry from an empty one and silently count zero), while
                // an unnecessary fetch only costs a query. Fail safe, not fast.
                if (!entry.DemandsUnfiltered && entry.Variants.Count == 0)
                    entry.DemandsUnfiltered = true;
            }

            return result;
        }

        /// <summary>
        /// What the runtime pushes for one condition: its self filters (the group's filters on the
        /// condition's own node, owned by it or by no condition) and its search criteria. Shared
        /// by the planner and PushdownChecks, so the TRAV_PUSHDOWN warning fires exactly when a
        /// criterion stays in memory (spec §3.5). Substring operators stay in memory until
        /// per-column metadata reaches the planner (`contains` on a multi-select column means
        /// value-overlap). Anchored date expressions bind per root when the anchor is a single
        /// record outside this condition's branch. With <paramref name="kinds"/> (column
        /// behaviors) the self filters' date values push exactly in <paramref name="zone"/>, and a
        /// column metadata says is not a date takes no date path; null ⇒ unknown behavior (date
        /// values push widened, ranges only). Null when the condition has nothing to translate.
        /// </summary>
        public static PushdownResult TranslateCondition(ConditionGroup group, RuleCondition condition,
            TableConfigTree tree, DateTime? utcNow, IDateColumnKindProvider kinds, TimeZoneInfo zone)
        {
            var selfFilters = (group.NodeFilterGroups ?? new List<NodeFilterGroup>())
                .Where(f => f.RuleConditionId == null || f.RuleConditionId == condition.Id)
                .Where(f => f.TableConfigNodeId == condition.TableConfigNodeId)
                .ToList();
            var searchGroups = condition.SearchCriteriaGroups ?? new List<SearchCriteriaGroup>();
            if (selfFilters.Count == 0 && searchGroups.Count == 0) return null;

            var nodeId = condition.TableConfigNodeId;
            var table = tree != null && tree.TryGetNode(nodeId, out var filtered) ? filtered.TableLogicalName : null;
            Func<string, DateColumnKind?> dateKindOf = null;
            Func<Guid, string, DateColumnKind?> anchorKindOf = null;
            if (kinds != null && table != null)
            {
                dateKindOf = column => kinds.GetDateKind(table, column);
                anchorKindOf = (anchor, column) =>
                    tree.TryGetNode(anchor, out var anchorNode) ? kinds.GetDateKind(anchorNode.TableLogicalName, column) : null;
            }
            return Translate(selfFilters, searchGroups, utcNow,
                anchor => CanBindAnchor(tree, nodeId, anchor), dateKindOf, zone, anchorKindOf);
        }

        /// <summary>Translates one AND-rooted tree of every self filter and every search-criteria
        /// group (each a conjunct, matching in-memory semantics, where each is applied
        /// independently). Self filters compare dates in memory by column behavior (DateSemantics),
        /// so they take the exact date values. Search criteria compare as text in memory
        /// (SearchCriteriaEvaluator): `ne 2026-09-01` keeps every row there, so an exact value
        /// could drop rows it keeps, and they keep the unknown-behavior fallback. Translating the
        /// two halves apart and concatenating their conjuncts gives the same tree as translating
        /// the combined root: an AND root with only child groups pushes each child it can.</summary>
        private static PushdownResult Translate(List<NodeFilterGroup> selfFilters, List<SearchCriteriaGroup> searchGroups,
            DateTime? utcNow, Func<Guid, bool> canBindAnchor, Func<string, DateColumnKind?> dateKindOf, TimeZoneInfo zone,
            Func<Guid, string, DateColumnKind?> anchorKindOf)
        {
            var filters = new PushdownTranslator(pushSubstringOperators: false, utcNow: utcNow,
                canBindAnchor: canBindAnchor, dateKindOf: dateKindOf, zone: zone, anchorKindOf: anchorKindOf)
                .Translate(Combine(selfFilters, new List<SearchCriteriaGroup>()));
            var criteria = new PushdownTranslator(pushSubstringOperators: false, utcNow: utcNow,
                canBindAnchor: canBindAnchor)
                .Translate(Combine(new List<NodeFilterGroup>(), searchGroups));

            var pushed = new PushedFilter { Op = LogicalOperator.And };
            if (filters.Pushed != null) pushed.Children.AddRange(filters.Pushed.Children);
            if (criteria.Pushed != null) pushed.Children.AddRange(criteria.Pushed.Children);
            return new PushdownResult
            {
                Pushed = pushed.IsEmpty ? null : pushed,
                HasResidual = filters.HasResidual || criteria.HasResidual,
            };
        }

        /// <summary>One AND-rooted tree: every self filter and every search-criteria group is a
        /// conjunct (matching in-memory semantics, where each is applied independently).</summary>
        private static NodeFilterGroup Combine(List<NodeFilterGroup> selfFilters, List<SearchCriteriaGroup> searchGroups)
        {
            var root = new NodeFilterGroup { LogicalOperator = LogicalOperator.And };
            root.ChildGroups.AddRange(selfFilters);
            foreach (var sg in searchGroups)
                root.ChildGroups.Add(ConvertSearchGroup(sg));
            return root;
        }

        private static NodeFilterGroup ConvertSearchGroup(SearchCriteriaGroup sg)
        {
            var g = new NodeFilterGroup { LogicalOperator = sg.LogicalOperator };
            foreach (var c in sg.Criteria ?? new List<SearchCriterion>())
                g.Criteria.Add(new NodeFilterCriterion
                {
                    Kind = CriterionKind.Comparison,
                    FieldName = c.FieldName,
                    Operator = c.Operator,
                    Value = c.Value,
                    ValueSource = ComparisonValueSource.Literal,
                });
            foreach (var child in sg.ChildGroups ?? new List<SearchCriteriaGroup>())
                g.ChildGroups.Add(ConvertSearchGroup(child));
            return g;
        }

        private static IEnumerable<ConditionGroup> Flatten(IEnumerable<ConditionGroup> groups)
        {
            foreach (var g in groups ?? Enumerable.Empty<ConditionGroup>())
            {
                yield return g;
                foreach (var d in Flatten(g.ChildGroups)) yield return d;
            }
        }

        private static IEnumerable<NodeFilterGroup> FlattenFilterGroups(IEnumerable<NodeFilterGroup> groups)
        {
            foreach (var g in groups ?? Enumerable.Empty<NodeFilterGroup>())
            {
                yield return g;
                foreach (var d in FlattenFilterGroups(g.ChildGroups)) yield return d;
            }
        }

        /// <summary>Whether a date expression filtering <paramref name="filteredNodeId"/> may bind
        /// per root to <paramref name="anchorNodeId"/>'s record: the anchor must be one record per
        /// root (the root, or a lookup chain from it) and must not be the filtered node or below
        /// it. The executor fetches every unfiltered entry before any variant, so such an anchor is
        /// always loaded when the variant binds. Shared with PushdownChecks so the publish warning
        /// and the runtime agree.</summary>
        public static bool CanBindAnchor(TableConfigTree tree, Guid filteredNodeId, Guid anchorNodeId) =>
            tree != null
            && tree.Contains(anchorNodeId)
            && tree.TrySingleCardinality(anchorNodeId)
            && !tree.IsSelfOrAncestor(filteredNodeId, anchorNodeId);

        // Every node a filter group's own criteria read: RHS value nodes, date-expression anchor nodes,
        // EXISTS collections, and (recursively) everything an EXISTS sub-filter reads. Child groups
        // are reached by the caller's FlattenFilterGroups walk, so only this group's criteria are visited here.
        private static IEnumerable<Guid> CriterionNodeIds(NodeFilterGroup g)
        {
            foreach (var crit in g.Criteria ?? new List<NodeFilterCriterion>())
            {
                if (crit.ComparisonValueNodeId.HasValue) yield return crit.ComparisonValueNodeId.Value;
                // A date anchor is read from the node's UNFILTERED entry (in memory, and when a
                // placeholder binds), so it must be demanded even when the node has its own variant.
                if (crit.ValueSource == ComparisonValueSource.DateExpression
                    && DateExprSpec.TryGetAnchorNode(crit.Value, out var anchor))
                    yield return anchor;
                if (crit.Kind != CriterionKind.Exists) continue;
                if (crit.CollectionNodeId.HasValue) yield return crit.CollectionNodeId.Value;
                foreach (var sub in FlattenFilterGroups(crit.SubFilter == null ? null : new[] { crit.SubFilter }))
                    foreach (var id in CriterionNodeIds(sub)) yield return id;
            }
        }
    }
}
