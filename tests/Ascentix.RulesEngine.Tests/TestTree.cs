using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>Shared config-tree + cache builders for evaluator and validator tests.
    ///
    /// <see cref="Tree"/> builds through <see cref="TableConfigTree.FromLoadedNodes"/>, so a test
    /// gets exactly the validated, depth-resolved tree the engine gets: a shape the loader would
    /// refuse (no root, cycle, missing parent) fails the test at construction. <see cref="RawTree"/>
    /// builds through <see cref="TableConfigTree.FromNodesUnvalidated"/>, what the validator holds
    /// (it reports a broken shape rather than throwing), and what negative-shape tests need.</summary>
    internal static class TestTree
    {
        public static TableConfig Node(Guid id, string table, TableConfigType type,
            Guid? parent, string childLinkField = null) =>
            new TableConfig
            {
                Id = id,
                TableLogicalName = table,
                ConfigType = type,
                ParentTableId = parent,
                ChildLinkField = childLinkField
            };

        /// <summary>A validated forest (what the loader returns).</summary>
        public static TableConfigTree Tree(params TableConfig[] nodes) =>
            TableConfigTree.FromLoadedNodes(nodes);

        /// <summary>A validated forest from a hand-built node map.</summary>
        public static TableConfigTree Tree(IReadOnlyDictionary<Guid, TableConfig> configs) =>
            TableConfigTree.FromLoadedNodes(configs.Values);

        /// <summary>An UNVALIDATED forest: what the validator holds; also for shapes the loader would refuse.</summary>
        public static TableConfigTree RawTree(params TableConfig[] nodes) =>
            TableConfigTree.FromNodesUnvalidated(nodes);

        /// <summary>An UNVALIDATED forest from a hand-built node map.</summary>
        public static TableConfigTree RawTree(IReadOnlyDictionary<Guid, TableConfig> configs) =>
            TableConfigTree.FromNodesUnvalidated(configs.Values);

        public static QueryResultCache Cache(params (Guid nodeId, List<Entity> rows)[] entries)
        {
            var c = new QueryResultCache();
            foreach (var e in entries) c.Store(e.nodeId, e.rows);
            return c;
        }

        public static Entity Row(string table, Guid id, params (string attr, object val)[] attrs)
        {
            var e = new Entity(table) { Id = id };
            foreach (var a in attrs) e[a.attr] = a.val;
            return e;
        }

        /// <summary>An <see cref="EvaluationInput"/> for one record (what the gather stage would
        /// hand <see cref="Engine.BucketEvaluator"/>) from a hand-built tree, a hand-populated
        /// cache (roots already stored) and the mapped groups/actions. Rule order defaults to
        /// first appearance across groups then actions; the mapping memo defaults to every
        /// action's parsed mapping.</summary>
        public static EvaluationInput Input(
            TableConfigTree tree,
            QueryResultCache cache,
            Entity root,
            IEnumerable<ConditionGroup> groups,
            IEnumerable<RuleAction> actions,
            IAttributeMetadataProvider metadata = null,
            IOptionLabelProvider labels = null,
            int languageId = 1033,
            DateTime? utcNow = null,
            RuleEvaluationContext context = RuleEvaluationContext.User,
            RuleTrigger trigger = RuleTrigger.Manual,
            PushdownPlan pushdown = null,
            IReadOnlyDictionary<Guid, List<FieldMappingEntry>> mappings = null,
            IEnumerable<Guid> ruleIds = null) =>
            Input(tree, new[] { (root, cache) }, groups, actions, metadata, labels, languageId, utcNow,
                context, trigger, pushdown, mappings, ruleIds);

        /// <summary>Multi-record form: one (root, cache) pair per record, index = position.</summary>
        public static EvaluationInput Input(
            TableConfigTree tree,
            IList<(Entity root, QueryResultCache cache)> records,
            IEnumerable<ConditionGroup> groups,
            IEnumerable<RuleAction> actions,
            IAttributeMetadataProvider metadata = null,
            IOptionLabelProvider labels = null,
            int languageId = 1033,
            DateTime? utcNow = null,
            RuleEvaluationContext context = RuleEvaluationContext.User,
            RuleTrigger trigger = RuleTrigger.Manual,
            PushdownPlan pushdown = null,
            IReadOnlyDictionary<Guid, List<FieldMappingEntry>> mappings = null,
            IEnumerable<Guid> ruleIds = null)
        {
            var groupList = groups?.ToList() ?? new List<ConditionGroup>();
            var actionList = actions?.ToList() ?? new List<RuleAction>();
            var ids = ruleIds?.ToList()
                ?? groupList.Select(g => g.RuleId).Concat(actionList.Select(a => a.RuleId)).Distinct().ToList();
            var actionsByRule = actionList.GroupBy(a => a.RuleId).ToDictionary(g => g.Key, g => g.ToList());
            var memo = mappings ?? actionList
                .Where(a => !string.IsNullOrWhiteSpace(a.FieldMapping))
                .ToDictionary(a => a.Id, a => FieldMappingParser.Parse(a.FieldMapping));
            var evalRecords = records
                .Select((r, i) => new EvaluationInput.EvaluationRecord(i, r.root, r.cache))
                .ToList();
            return new EvaluationInput(
                ruleIds: ids,
                rootGroups: groupList,
                actionsByRule: actionsByRule,
                mappingsByAction: memo,
                tree: tree,
                pushdown: pushdown,
                records: evalRecords,
                languageId: languageId,
                context: context,
                utcNow: utcNow ?? new DateTime(2026, 8, 23, 12, 0, 0, DateTimeKind.Utc),
                metadata: metadata,
                labels: labels ?? metadata as IOptionLabelProvider,
                trigger: trigger);
        }
    }
}
