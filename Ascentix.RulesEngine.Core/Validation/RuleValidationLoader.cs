using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>
    /// Assembles a RuleForValidation from the existing loaders (status-agnostic LoadRuleById),
    /// mirroring TableRuleAnalyzer's load sequence. Returns null when the rule is absent.
    /// </summary>
    public static class RuleValidationLoader
    {
        private static readonly string RuleTableField = SchemaNames.Qualify(SchemaNames.Rule.TableLogicalName);

        public static RuleForValidation Load(IOrganizationService service, Guid ruleId)
        {
            var rules = new RuleLoader(service).LoadRuleById(ruleId);
            if (rules.Count == 0) return null;
            var rule = rules[0];

            var groups = new ConditionGroupMapper().MapConditionGroups(rules);

            new RuleActionLoader(service).LoadActionsByRule(new[] { ruleId })
                .TryGetValue(ruleId, out var actions);
            actions = actions ?? new List<RuleAction>();

            // The validator's config set is the SAME reference set the runtime seeds from
            // (RuleReferences), so a valid rule can never fail TRAV_NODE_NOT_FOUND on a node the
            // runtime would have loaded, and vice versa.
            var refs = RuleReferences.Compute(groups, actions);

            // Unvalidated on purpose: the loader's seeded-ids check still throws (a node the rule
            // references that did not load is not a shape the validator can reason about), but a
            // cycle / missing parent / rootless forest is the validator's to REPORT, never to throw.
            var configs = refs.NodesToLoad.Count > 0 || refs.OptionalNodes.Count > 0
                ? TableConfigTree.FromNodesUnvalidated(
                    new TableConfigLoader(service).LoadNodes(refs.NodesToLoad.Cast<object>().ToArray(), refs.OptionalNodes))
                : TableConfigTree.Empty;

            return new RuleForValidation
            {
                RuleId = ruleId,
                RuleEntity = rule,
                PrimaryTable = rule.GetAttributeValue<string>(RuleTableField),
                Groups = groups,
                Configs = configs,
                Actions = actions,
                References = refs,
                TriggerColumns = Ascentix.RulesEngine.Core.Actions.TriggerColumns.Parse(
                    rule.GetAttributeValue<string>(SchemaNames.Qualify(SchemaNames.Rule.TriggerColumns)))
            };
        }
    }
}
