using System;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Localization;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Main-operation handler for the unbound asx_ApplyRules Custom API. Evaluates one published
    /// On demand rule against one record and, when it does not block, applies its fired writes
    /// (the enforcing adapter for a single record; a fired Block throws, never reported as data).
    /// </summary>
    public class ApplyRulesApi : PluginBase
    {
        public ApplyRulesApi() : base(typeof(ApplyRulesApi)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            if (local == null) throw new ArgumentNullException(nameof(local));

            var context = local.PluginExecutionContext;
            var system = local.SystemUserService;
            var user = local.CurrentUserService;
            var trace = local.TracingService;

            var ruleId = RequiredGuid(context, SchemaNames.ApplyRulesApi.ParamRuleId);
            var recordId = RequiredGuid(context, SchemaNames.ApplyRulesApi.ParamRecordId);
            var languageId = LanguageResolver.Resolve(system, context.InitiatingUserId);

            var rule = OnDemandRules.Resolve(system, ruleId, trace);
            var evaluator = new OnDemandEvaluator(system, user, languageId, trace);
            if (!evaluator.Existing(rule.Table, new[] { recordId }).Contains(recordId))
                throw new InvalidPluginExecutionException($"Record {recordId} was not found in {rule.Table}.");

            var outcome = evaluator.Evaluate(rule, new[] { recordId });
            var record = outcome.Records[0];
            if (record.HasBlock)
                throw new InvalidPluginExecutionException(ActionDispatcher.FormatBlockMessage(record.BlockingMessages, languageId));

            var writes = new WriteActionExecutor().ExecuteRecord(record, null, user, system,
                PluginReentry.IsEngineInitiated(context), trace);

            context.OutputParameters[SchemaNames.ApplyRulesApi.PropIsValid] = true;
            context.OutputParameters[SchemaNames.ApplyRulesApi.PropResults] = RunRulesResultSerializer.Serialize(outcome);
            context.OutputParameters[SchemaNames.ApplyRulesApi.PropWriteCount] = writes;
        }

        // The Custom API declares RuleId/RecordId as Guid parameters, but tests (and some
        // callers) may pass a parseable string instead, so both are accepted.
        private static Guid RequiredGuid(IPluginExecutionContext context, string name)
        {
            if (context.InputParameters.TryGetValue(name, out var raw))
            {
                if (raw is Guid g) return g;
                if (raw is string s && Guid.TryParse(s, out var parsed)) return parsed;
            }
            throw new InvalidPluginExecutionException($"asx_ApplyRules: {name} is required.");
        }
    }
}
