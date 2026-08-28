using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin.Registration
{
    /// <summary>
    /// Loads all active rules for a table and builds the per-rule RuleAnalysis the
    /// StepPlanner consumes: server-relevance (any active Block action), which server
    /// triggers the rule carries, whether it is root-only, and its root columns. An adapter
    /// of the rule reference set (<see cref="RuleReferences.RootColumns"/> /
    /// <see cref="RuleReferences.IsRootOnly"/>) over the engine's existing loaders/mappers.
    /// </summary>
    public class TableRuleAnalyzer
    {
        private static readonly string TriggersField = SchemaNames.Qualify(SchemaNames.Rule.Triggers);
        private static readonly string TriggerColumnsField = SchemaNames.Qualify(SchemaNames.Rule.TriggerColumns);

        private readonly IOrganizationService _service;

        public TableRuleAnalyzer(IOrganizationService service)
        {
            _service = service;
        }

        public List<RuleAnalysis> Analyze(string tableLogicalName, InFlightChange change)
        {
            var loader = new RuleLoader(_service);
            var rules = loader.LoadRules(tableLogicalName);

            // A publish adds a rule the committed (Published-only) re-query cannot see yet.
            Entity extraRule = null;
            if (change != null && change.IsRulePublish
                && string.Equals(change.EffectiveTable, tableLogicalName, StringComparison.OrdinalIgnoreCase)
                && rules.All(r => r.Id != change.RecordId))
            {
                extraRule = loader.LoadRuleById(change.RecordId).FirstOrDefault();
            }

            rules = EffectiveState.ApplyRuleDelta(rules, change, extraRule, tableLogicalName);
            if (!rules.Any()) return new List<RuleAnalysis>();

            var rootGroups = new ConditionGroupMapper().MapConditionGroups(rules);

            var actionsByRule = new RuleActionLoader(_service).LoadActionsByRule(rules.Select(r => r.Id));
            actionsByRule = EffectiveState.ApplyActionDelta(actionsByRule, change);

            // Condition nodes are required (as they always were); every other referenced node
            // (action targets, mapping sources, message tokens) loads as OPTIONAL so the root-only
            // verdict can see whether it is a root, while a stale reference on one rule cannot
            // abort the analysis of the whole table (it answers "not root-only": fail closed).
            var allRefs = RuleReferences.Compute(rootGroups, actionsByRule.Values.SelectMany(v => v));
            var required = allRefs.NodeIds(ReferenceKind.ConditionNodes, ReferenceKind.FieldReferenceNodes);
            var optional = allRefs.NodesToLoad.Concat(allRefs.OptionalNodes).Where(id => !required.Contains(id)).ToList();
            var tree = TableConfigTree.Empty;
            if (required.Count > 0 || optional.Count > 0)
            {
                var nodes = new TableConfigLoader(_service).LoadNodes(required.Cast<object>().ToArray(), optional);
                if (nodes.Count > 0) tree = TableConfigTree.FromLoadedNodes(nodes);
            }

            var result = new List<RuleAnalysis>();
            foreach (var rule in rules)
            {
                var ruleGroups = rootGroups.Where(g => g.RuleId == rule.Id).ToList();
                var triggers = rule.GetAttributeValue<OptionSetValueCollection>(TriggersField)
                               ?? new OptionSetValueCollection();

                actionsByRule.TryGetValue(rule.Id, out var actions);
                actions = actions ?? new List<RuleAction>();
                // A null/unknown asx_actiontype (hand-created or half-saved row; the loader maps
                // null to 0) contributes nothing to the step decision, consistent with the
                // sibling loader/collector guards. Without this guard a single malformed action
                // row would block every later publish/reconcile of the table instead.
                var hasServerAction = actions
                    .Where(a => Enum.IsDefined(typeof(ActionType), a.ActionType))
                    .Any(a => a.IsActive && ActionDispatcher.IsServerAction(a.ActionType));

                var refs = RuleReferences.Compute(ruleGroups, actions);
                var rootColumns = refs.RootColumns(tree);
                foreach (var tc in TriggerColumns.Parse(rule.GetAttributeValue<string>(TriggerColumnsField)))
                    rootColumns.Add(tc);

                result.Add(new RuleAnalysis
                {
                    HasServerAction = hasServerAction,
                    OnCreate = triggers.Any(o => o.Value == (int)RuleTrigger.OnCreate),
                    OnUpdate = triggers.Any(o => o.Value == (int)RuleTrigger.OnUpdate),
                    OnDelete = triggers.Any(o => o.Value == (int)RuleTrigger.OnDelete),
                    IsRootOnly = refs.IsRootOnly(tree),
                    RootColumns = rootColumns
                });
            }
            return result;
        }
    }
}
