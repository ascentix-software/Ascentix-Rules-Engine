using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>One bucket's plan, built before any business data is read: what
    /// <see cref="EvaluationGatherer.Gather"/> needs, and the demands the run's
    /// <see cref="RunFetchStore"/> combines across buckets.</summary>
    public sealed class PreparedBucket
    {
        internal IOrganizationService TraversalService;
        internal List<Entity> Rules;
        internal RuleEvaluationContext Context;
        internal List<ConditionGroup> RootGroups;
        internal Dictionary<Guid, List<RuleAction>> ActionsByRule;
        internal Dictionary<Guid, List<FieldMappingEntry>> ParsedMappings;
        internal List<RuleAction> AllActions;
        internal TableConfigTree Tree;
        internal Dictionary<Guid, DateSemantics> DatesByRule;
        internal QueryExecutionPlan Plan;
        internal PushdownPlan Pushdown;
        internal HashSet<string> RootColumns;
        internal bool RootAllColumns;
        internal AttributeMetadataProvider Metadata;
    }

    /// <summary>
    /// Gather, step two, in two halves: <see cref="Prepare"/> builds a bucket's plan without
    /// reading business data (conditionMap → actionLoad → references → tableConfigLoad →
    /// planBuild → self-node pass); <see cref="Gather"/> reads the bucket's rows (rootBuild →
    /// in-flight batch → per-root queryExecute) through the run's <see cref="RunFetchStore"/>.
    /// Owns those stage timers. Nothing here evaluates a rule; nothing after here reads a
    /// service. configurationService reads rule config and metadata;
    /// traversalService reads business data (root retrieval + QueryExecutor). On Update, a
    /// changed root-level lookup with ticked actions runs the same plan a second time, rooted at
    /// the lookup's previous record (see <see cref="PreviousParent"/>).
    /// </summary>
    public static class EvaluationGatherer
    {
        public static PreparedBucket Prepare(
            IOrganizationService configurationService,
            IOrganizationService traversalService,
            string logicalName,
            RootBuildMode buildMode,
            List<Entity> rules,
            RuleEvaluationContext bucketContext,
            DateTime utcNow,
            RunDiagnostics diag,
            AttributeMetadataProvider metadata = null)
        {
            List<ConditionGroup> rootGroups;
            List<RuleCondition> flatConditions;
            using (diag.Time("conditionMap"))
            {
                var mapper0 = new ConditionGroupMapper();
                rootGroups = mapper0.MapConditionGroups(rules);
                flatConditions = FlattenConditions(rootGroups);
            }
            Dictionary<Guid, List<RuleAction>> actionsByRule;
            using (diag.Time("actionLoad"))
                actionsByRule = new RuleActionLoader(configurationService).LoadActionsByRule(rules.Select(r => r.Id));

            var parsedMappings = new Dictionary<Guid, List<FieldMappingEntry>>();
            List<FieldMappingEntry> ParseMapping(Guid actionId, string json)
            {
                if (!parsedMappings.TryGetValue(actionId, out var m))
                {
                    m = FieldMappingParser.Parse(json);
                    parsedMappings[actionId] = m;
                }
                return m;
            }

            // One computation of everything the bucket's rules touch; every derivation below is
            // a named answer of it (see RuleReferences). Message-token nodes nothing else
            // references load as OPTIONAL: a stale token degrades to raw text at render time
            // rather than refusing the save. A Create's target joins only when it is Create per row
            // (a collection), told apart from a stale single-record target by its own config chain.
            var allActions = actionsByRule.Values.SelectMany(v => v).ToList();
            TableConfigTree createTargets;
            using (diag.Time("tableConfigLoad"))
                createTargets = new TableConfigLoader(configurationService).LoadCreateTargets(allActions);
            var refs = RuleReferences.Compute(
                rootGroups, allActions, a => ParseMapping(a.Id, a.FieldMapping), createTargets);

            TableConfigTree tree;
            using (diag.Time("tableConfigLoad"))
                tree = refs.NodesToLoad.Count > 0
                    ? new TableConfigLoader(configurationService).LoadConfigs(refs.NodesToLoad.Cast<object>().ToArray(), refs.OptionalNodes)
                    : TableConfigTree.Empty;

            // Lazy and service-backed: one RetrieveEntityRequest per distinct table, on first
            // ask. The runner shares one provider across every bucket of a run (null ⇒ one for
            // this bucket). Not pre-warmed: the evaluator only sees the interfaces. The planner
            // reads date behaviors from it too (exact date pushdown).
            metadata = metadata ?? new AttributeMetadataProvider(configurationService);

            // Per-rule date semantics: column behavior from metadata (read lazily, per table, on
            // the first date comparison) and the rule's time zone. An unknown zone fails the
            // save with a named error; publish rejects it first (STRUCT_INVALID_TIMEZONE).
            var datesByRule = rules.ToDictionary(r => r.Id,
                r => new DateSemantics(metadata, EvaluationZone.Resolve(EvaluationZone.SettingOf(r))));

            QueryExecutionPlan plan;
            PushdownPlan pushdownPlan;
            HashSet<string> rootColumns;
            using (diag.Time("planBuild"))
            {
                plan = QueryExecutionPlan.Build(tree, flatConditions, refs.NodesToPlan);
                // Pushdown is unconditional: one supported behavior, no mode switch. The
                // in-memory evaluator remains the single semantic authority: pushdown only ever
                // reduces rows, and the full original filter re-applies over what comes back.
                // Rows filters run in memory over the unfiltered rows, so their nodes are demanded
                // like hard readers.
                pushdownPlan = PushdownPlanner.Apply(plan, tree, rootGroups, refs.HardReaders.Concat(refs.ActionFilterNodes), refs.FilterDerivedNodes, utcNow,
                    metadata, datesByRule.ToDictionary(kv => kv.Key, kv => kv.Value.Zone));

                // Column pruning: an unpruneable node is one whose consumers the
                // collector cannot enumerate: a missed column reads as silently-null, so
                // precision is only claimed where structured.
                var prunedColumns = TraversalColumnCollector.Collect(tree, rootGroups, refs.Unpruneable);
                foreach (var entry in plan.Levels.SelectMany(l => l))
                    if (prunedColumns.TryGetValue(entry.Node.Id, out var cols))
                        entry.Columns = cols;
                rootColumns = refs.RootColumns(tree);
            }

            // In-flight reconciliation: nodes that re-read the ROOT's own table are fetched at
            // pre-operation, so InFlightReconciler may have to add the triggering record back
            // into their results. What it adds is the root entity, so the root read has to cover
            // what those nodes' consumers read off a row.
            var selfNodes = plan.Levels.SelectMany(l => l)
                .Where(e => string.Equals(e.Node.TableLogicalName, logicalName, StringComparison.OrdinalIgnoreCase))
                .ToList();
            foreach (var e in selfNodes)
            {
                if (e.Columns != null)
                    foreach (var c in e.Columns) rootColumns.Add(c);
                // The link back to the parent is what decides whether the record belongs here.
                if (e.Node.ConfigType == TableConfigType.ChildTable
                    && !string.IsNullOrWhiteSpace(e.Node.ChildLinkField))
                    rootColumns.Add(e.Node.ChildLinkField);
            }
            // A node the collector refused to prune (Columns == null) reads columns nothing can
            // enumerate. That only forces a full-width root read when a pushed filter could keep
            // the in-flight row out of the fetch and leave the reconciler to add it back. On
            // Create the root IS the Target, which already carries everything that was set.
            var rootAllColumns = buildMode == RootBuildMode.RetrieveAndOverlay
                && selfNodes.Any(e => e.Columns == null && e.Variants != null && e.Variants.Count > 0);

            return new PreparedBucket
            {
                TraversalService = traversalService,
                Rules = rules,
                Context = bucketContext,
                RootGroups = rootGroups,
                ActionsByRule = actionsByRule,
                ParsedMappings = parsedMappings,
                AllActions = allActions,
                Tree = tree,
                DatesByRule = datesByRule,
                Plan = plan,
                Pushdown = pushdownPlan,
                RootColumns = rootColumns,
                RootAllColumns = rootAllColumns,
                Metadata = metadata,
            };
        }

        /// <summary>Registers the bucket's child-column and root-column demands with the run's
        /// store, so every bucket's requests ask for the combined columns.</summary>
        public static void Demand(PreparedBucket bucket, RunFetchStore store, RootBuildMode buildMode)
        {
            foreach (var entry in bucket.Plan.Levels.SelectMany(l => l))
                if (entry.Node.ConfigType == TableConfigType.ChildTable)
                    store.DemandColumns(bucket.TraversalService, entry.Node, entry.Columns);
            if (buildMode != RootBuildMode.UseTarget)
                store.DemandRootColumns(bucket.TraversalService, bucket.RootColumns, bucket.RootAllColumns);
        }

        public static EvaluationInput Gather(
            PreparedBucket bucket,
            string logicalName,
            IList<RootInput> inputs,
            RootBuildMode buildMode,
            RuleTrigger trigger,
            int languageId,
            RunFetchStore store,
            DateTime utcNow,
            RunDiagnostics diag)
        {
            var tree = bucket.Tree;

            // On Update the saved record (before the overlay) tells which lookups this save changed.
            var saved = trigger == RuleTrigger.OnUpdate && buildMode == RootBuildMode.RetrieveAndOverlay
                ? new List<Entity>() : null;
            List<Entity> roots;
            using (diag.Time("rootBuild"))
            {
                var retrieved = buildMode == RootBuildMode.UseTarget
                    ? null
                    : store.RootsFor(bucket.TraversalService, logicalName, inputs);
                roots = RootEntityBuilder.Assemble(logicalName, inputs, retrieved, buildMode, saved);
            }
            var inFlight = BuildInFlightBatch(logicalName, trigger, inputs, roots);

            // One group fetch per plan node for all of the bucket's roots (QueryExecutor.ExecuteMany),
            // split back per root; a single save is a group of one.
            IReadOnlyList<QueryResultCache> caches = null;
            if (tree.Count > 0)
                using (diag.Time("queryExecute"))
                    caches = new QueryExecutor(bucket.TraversalService, new QueryResultCache(tree), tree, diag, utcNow,
                            trigger == RuleTrigger.OnCreate, store)
                        .ExecuteMany(roots, bucket.Plan, inFlight);

            var records = new List<EvaluationInput.EvaluationRecord>(roots.Count);
            for (var i = 0; i < roots.Count; i++)
            {
                var root = roots[i];
                var cache = caches != null ? caches[i] : new QueryResultCache(tree);
                var previousRuns = new List<EvaluationInput.PreviousRun>();

                // A changed lookup with ticked actions: run the same plan again with the lookup
                // pointed at its previous record (own cache; same in-flight batch, so the moved
                // row leaves the previous parent's collections). Same store: collections the
                // two runs share are read once.
                if (tree.Count > 0 && saved != null)
                    foreach (var changed in PreviousParent.Changed(tree, bucket.AllActions, saved[i], inputs[i].Overlay))
                    {
                        var previousRoot = PreviousParent.RootFor(root, changed);
                        var previousCache = new QueryResultCache(tree);
                        using (diag.Time("queryExecute"))
                            new QueryExecutor(bucket.TraversalService, previousCache, tree, diag, utcNow, rootIsNew: false, store: store)
                                .Execute(previousRoot, bucket.Plan, inFlight);
                        previousRuns.Add(new EvaluationInput.PreviousRun(changed.Lookup, previousRoot, previousCache));
                    }
                records.Add(new EvaluationInput.EvaluationRecord(i, root, cache, previousRuns));
            }

            return new EvaluationInput(
                ruleIds: bucket.Rules.Select(r => r.Id).ToList(),
                rootGroups: bucket.RootGroups,
                actionsByRule: bucket.ActionsByRule,
                mappingsByAction: bucket.ParsedMappings,
                tree: tree,
                pushdown: bucket.Pushdown,
                records: records,
                languageId: languageId,
                context: bucket.Context,
                utcNow: utcNow,
                metadata: bucket.Metadata,
                labels: bucket.Metadata,
                trigger: trigger,
                datesByRule: bucket.DatesByRule);
        }

        // The pending row change, as the traversal must see it. Built from the whole input set,
        // not just the record being evaluated: in an UpdateMultiple/CreateMultiple every sibling
        // in the batch is equally unsaved, so evaluating one of them must see all of them.
        private static InFlightBatch BuildInFlightBatch(
            string logicalName, RuleTrigger trigger, IList<RootInput> inputs, List<Entity> roots)
        {
            InFlightOperation operation;
            switch (trigger)
            {
                case RuleTrigger.OnCreate: operation = InFlightOperation.Create; break;
                case RuleTrigger.OnUpdate: operation = InFlightOperation.Update; break;
                case RuleTrigger.OnDelete: operation = InFlightOperation.Delete; break;
                // OnForm/Manual evaluate committed records; nothing is pending to reconcile.
                default: return null;
            }

            var batch = new InFlightBatch { LogicalName = logicalName, Operation = operation };
            for (var i = 0; i < roots.Count && i < inputs.Count; i++)
            {
                var root = roots[i];
                if (root == null) continue;
                batch.Records.Add(new InFlightRecord
                {
                    // Create supplies the id on the Target (the platform assigns it before
                    // pre-operation); Update/Delete carry it on the input.
                    Id = inputs[i].Id != Guid.Empty ? inputs[i].Id : root.Id,
                    Target = inputs[i].Overlay,
                    Root = root
                });
            }
            return batch;
        }

        private static List<RuleCondition> FlattenConditions(List<ConditionGroup> rootGroups)
        {
            var conditions = new List<RuleCondition>();
            foreach (var group in rootGroups) FlattenGroup(group, conditions);
            return conditions;
        }

        private static void FlattenGroup(ConditionGroup group, List<RuleCondition> conditions)
        {
            conditions.AddRange(group.Conditions);
            foreach (var childGroup in group.ChildGroups) FlattenGroup(childGroup, conditions);
        }
    }
}
