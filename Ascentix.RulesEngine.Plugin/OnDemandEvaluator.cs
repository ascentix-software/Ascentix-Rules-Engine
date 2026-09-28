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
    /// Shared on-demand evaluation: checks record existence (system service) and runs one
    /// On demand rule against a set of records (selection narrowed to that rule, any channel).
    /// Used by asx_ApplyRules (one record) and Rule Run page processing (many).
    /// </summary>
    public sealed class OnDemandEvaluator
    {
        private readonly IOrganizationService _system;
        private readonly IOrganizationService _user;
        private readonly int _languageId;
        private readonly ITracingService _trace;

        public OnDemandEvaluator(IOrganizationService system, IOrganizationService user, int languageId, ITracingService trace)
        {
            _system = system;
            _user = user;
            _languageId = languageId;
            _trace = trace;
        }

        /// <summary>Ids that exist in <paramref name="table"/>, found in one query.</summary>
        public HashSet<Guid> Existing(string table, IList<Guid> ids)
        {
            var found = new HashSet<Guid>();
            if (ids.Count == 0) return found;
            var query = new QueryExpression(table) { ColumnSet = new ColumnSet(false) };
            query.Criteria.AddCondition(table + "id", ConditionOperator.In, ids.Cast<object>().ToArray());
            foreach (var e in _system.RetrieveMultiple(query).Entities) found.Add(e.Id);
            return found;
        }

        /// <summary>Evaluates <paramref name="rule"/> against <paramref name="ids"/>: one Runner
        /// call, trigger OnDemand, retrieved persisted records, standard channel, narrowed to
        /// this rule across any channel it is tagged for.</summary>
        public RuleEvaluationOutcome Evaluate(OnDemandRule rule, IList<Guid> ids) =>
            new RulesEngineRunner().Run(_system, _user, rule.Table,
                ids.Select(id => new RootInput { Id = id, Overlay = null }).ToList(),
                RuleTrigger.OnDemand, RuleChannel.Standard, _languageId, RootBuildMode.RetrieveOnly, _trace,
                new RuleSelection { RuleId = rule.RuleId, AnyChannel = true });
    }
}
