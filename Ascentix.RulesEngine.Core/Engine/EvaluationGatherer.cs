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
    /// <summary>
    /// Gather, step two: everything one context bucket's evaluation needs, read from Dataverse
    /// in a fixed order (conditionMap → actionLoad → references → tableConfigLoad → planBuild
    /// → self-node pass → rootBuild → in-flight batch → per-root queryExecute) and handed over
    /// as an <see cref="EvaluationInput"/>. Owns those stage timers. Nothing here evaluates a
    /// rule; nothing after here reads a service. systemService reads rule config and metadata;
    /// traversalService reads business data (root retrieval + QueryExecutor).
    /// </summary>
    public static class EvaluationGatherer
    {
        public static EvaluationInput ForBucket(
            IOrganizationService systemService,
            IOrganizationService traversalService,
            string logicalName,
            IList<RootInput> inputs,
            RootBuildMode buildMode,
            RuleTrigger trigger,
            int languageId,
            List<Entity> rules,
            RuleEvaluationContext bucketContext,
            RunDiagnostics diag)
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
                actionsByRule = new RuleActionLoader(systemService).LoadActionsByRule(rules.Select(r => r.Id));

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
            // rather than refusing the save.
            var refs = RuleReferences.Compute(
                rootGroups, actionsByRule.Values.SelectMany(v => v), a => ParseMapping(a.Id, a.FieldMapping));

            TableConfigTree tree;
            using (diag.Time("tableConfigLoad"))
                tree = refs.NodesToLoad.Count > 0
                    ? new TableConfigLoader(systemService).LoadConfigs(refs.NodesToLoad.Cast<object>().ToArray(), refs.OptionalNodes)
                    : TableConfigTree.Empty;
            QueryExecutionPlan plan;
            PushdownPlan pushdownPlan;
            HashSet<string> rootColumns;
            using (diag.Time("planBuild"))
            {
                plan = QueryExecutionPlan.Build(tree, flatConditions, refs.NodesToPlan);
                // Pushdown is unconditional: one supported behavior, no mode switch. The
                // in-memory evaluator remains the single semantic authority: pushdown only ever
                // reduces rows, and the full original filter re-applies over what comes back.
                pushdownPlan = PushdownPlanner.Apply(plan, tree, rootGroups, refs.HardReaders, refs.FilterDerivedNodes);

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

            // Lazy and service-backed: one RetrieveEntityRequest per distinct table, on first
            // ask, for the lifetime of this bucket. Not pre-warmed: the evaluator only sees the
            // interfaces.
            var metadata = new AttributeMetadataProvider(systemService);
            var utcNow = DateTime.UtcNow;

            List<Entity> roots;
            using (diag.Time("rootBuild"))
                roots = RootEntityBuilder.Build(traversalService, logicalName, inputs, rootColumns, buildMode, rootAllColumns);
            var inFlight = BuildInFlightBatch(logicalName, trigger, inputs, roots);

            var records = new List<EvaluationInput.EvaluationRecord>(roots.Count);
            for (var i = 0; i < roots.Count; i++)
            {
                var root = roots[i];
                var cache = new QueryResultCache(tree);
                if (tree.Count > 0)
                    using (diag.Time("queryExecute"))
                        new QueryExecutor(traversalService, cache, tree, diag).Execute(root, plan, inFlight);
                records.Add(new EvaluationInput.EvaluationRecord(i, root, cache));
            }

            return new EvaluationInput(
                ruleIds: rules.Select(r => r.Id).ToList(),
                rootGroups: rootGroups,
                actionsByRule: actionsByRule,
                mappingsByAction: parsedMappings,
                tree: tree,
                pushdown: pushdownPlan,
                records: records,
                languageId: languageId,
                context: bucketContext,
                utcNow: utcNow,
                metadata: metadata,
                labels: metadata,
                trigger: trigger);
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
