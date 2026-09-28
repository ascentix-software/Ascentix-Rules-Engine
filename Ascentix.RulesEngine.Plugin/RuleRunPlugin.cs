using System;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Pre-operation, Create of asx_rulerun. Validates the requested run and queues it: resolves
    /// the rule (published, On demand, in its effective window), checks the record ids against the
    /// rule's scope, refuses a second concurrent run for the same rule, and stamps the Target with
    /// its starting state. asx_ProcessRunPage advances a queued run page by page.
    /// </summary>
    public sealed class RuleRunPlugin : PluginBase
    {
        private static string Q(string fragment) => SchemaNames.Qualify(fragment);

        public RuleRunPlugin() : base(typeof(RuleRunPlugin)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            var context = local.PluginExecutionContext;
            var system = local.SystemUserService;
            var trace = local.TracingService;

            var target = context.InputParameters.TryGetValue("Target", out var input) ? input as Entity : null;
            if (target == null) throw new InvalidPluginExecutionException("Choose the rule to run.");

            var ruleRef = target.GetAttributeValue<EntityReference>(Q(SchemaNames.RuleRun.Rule));
            if (ruleRef == null) throw new InvalidPluginExecutionException("Choose the rule to run.");

            var rule = OnDemandRules.Resolve(system, ruleRef.Id, trace);

            var ids = RunState.ParseRecordIds(target.GetAttributeValue<string>(Q(SchemaNames.RuleRun.RecordIds)));
            if (ids.Count > RunState.MaxRecordIds)
                throw new InvalidPluginExecutionException("A run can include at most 250 records.");
            if (ids.Count == 0 && rule.Scope == OnDemandScope.GivenRecord)
                throw new InvalidPluginExecutionException("This rule runs for records it's given. Choose the records to run it for.");

            var active = new QueryExpression(Q(SchemaNames.RuleRun.Entity)) { ColumnSet = new ColumnSet(false), TopCount = 1 };
            active.Criteria.AddCondition(Q(SchemaNames.RuleRun.Rule), ConditionOperator.Equal, ruleRef.Id);
            active.Criteria.AddCondition(Q(SchemaNames.RuleRun.Status), ConditionOperator.In, (int)RuleRunStatus.Queued, (int)RuleRunStatus.Running);
            if (system.RetrieveMultiple(active).Entities.Count > 0)
                throw new InvalidPluginExecutionException("This rule already has a run in progress. Cancel or resume it first.");

            var nowUtc = DateTime.UtcNow;
            target[Q(SchemaNames.RuleRun.Status)] = new OptionSetValue((int)RuleRunStatus.Queued);
            target[Q(SchemaNames.RuleRun.Scope)] = new OptionSetValue((int)(ids.Count > 0 ? OnDemandScope.GivenRecord : OnDemandScope.AllRecords));
            target[Q(SchemaNames.RuleRun.RecordIds)] = ids.Count > 0 ? RunState.WriteRecordIds(ids) : null;
            target[Q(SchemaNames.RuleRun.Evaluated)] = 0;
            target[Q(SchemaNames.RuleRun.Changed)] = 0;
            target[Q(SchemaNames.RuleRun.Blocked)] = 0;
            target[Q(SchemaNames.RuleRun.Failed)] = 0;
            target[Q(SchemaNames.RuleRun.Skipped)] = 0;
            target[Q(SchemaNames.RuleRun.StartedOn)] = nowUtc;

            if (string.IsNullOrWhiteSpace(target.GetAttributeValue<string>(Q(SchemaNames.RuleRun.Name))))
                target[Q(SchemaNames.RuleRun.Name)] = $"{rule.Name} – {nowUtc:yyyy-MM-dd HH:mm}";
        }
    }
}
