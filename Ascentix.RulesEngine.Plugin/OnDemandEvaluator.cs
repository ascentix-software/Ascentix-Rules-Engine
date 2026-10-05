using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Shared on-demand evaluation: checks which records exist and are readable in the rule's
    /// evaluation context, and runs one On demand rule against a set of records (selection
    /// narrowed to that rule, any channel).
    /// Used by asx_ApplyRules (one record) and Rule Run page processing (many).
    /// </summary>
    public sealed class OnDemandEvaluator
    {
        private readonly IOrganizationService _system;
        private readonly IOrganizationService _user;
        private readonly int _languageId;
        private readonly ITracingService _trace;

        // One loaded rule set per rule for the life of this evaluator (one Rule Run page).
        private readonly Dictionary<Guid, LoadedRulesCache> _rules = new Dictionary<Guid, LoadedRulesCache>();

        public OnDemandEvaluator(IOrganizationService system, IOrganizationService user, int languageId, ITracingService trace)
        {
            _system = system;
            _user = user;
            _languageId = languageId;
            _trace = trace;
        }

        /// <summary>The service that reads <paramref name="rule"/>'s records: the caller's for a
        /// User rule, the system's for a System rule. It matches the service the Runner builds the
        /// rule's roots with, so a row the caller can't read is never evaluated as a blank record.</summary>
        public IOrganizationService ReadService(OnDemandRule rule) =>
            rule.Context == RuleEvaluationContext.System ? _system : _user;

        /// <summary>Ids that exist in the rule's table and are readable in its evaluation
        /// context, found in one query.</summary>
        public HashSet<Guid> Existing(OnDemandRule rule, IList<Guid> ids)
        {
            var found = new HashSet<Guid>();
            if (ids.Count == 0) return found;
            var query = new QueryExpression(rule.Table) { ColumnSet = new ColumnSet(false) };
            query.Criteria.AddCondition(rule.Table + "id", ConditionOperator.In, ids.Cast<object>().ToArray());
            foreach (var e in ReadService(rule).RetrieveMultiple(query).Entities) found.Add(e.Id);
            return found;
        }

        /// <summary>Evaluates <paramref name="rule"/> against <paramref name="ids"/>: one Runner
        /// call, trigger OnDemand, retrieved persisted records, standard channel, narrowed to
        /// this rule across any channel it is tagged for. The rule is loaded on the first call for it
        /// and reused by later calls on this evaluator.</summary>
        public RuleEvaluationOutcome Evaluate(OnDemandRule rule, IList<Guid> ids)
        {
            if (!_rules.TryGetValue(rule.RuleId, out var loaded)) _rules[rule.RuleId] = loaded = new LoadedRulesCache();
            return new RulesEngineRunner().Run(_system, _user, rule.Table,
                ids.Select(id => new RootInput { Id = id, Overlay = null }).ToList(),
                RuleTrigger.OnDemand, RuleChannel.Standard, _languageId, RootBuildMode.RetrieveOnly, _trace,
                new RuleSelection { RuleId = rule.RuleId, AnyChannel = true }, loaded);
        }
    }
}
