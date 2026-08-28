using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Localization;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Main-operation handler for the unbound asx_RunRules Custom API. Evaluates one record on
    /// demand and reports results (IsValid / FailedRuleCount / Results JSON). Always non-enforcing:
    /// a fired Block is reported, never thrown. Throws only on argument/usage errors.
    /// </summary>
    public class RunRulesApi : PluginBase
    {
        public RunRulesApi() : base(typeof(RunRulesApi)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null) throw new ArgumentNullException(nameof(localPluginContext));

            var context = localPluginContext.PluginExecutionContext;
            var systemService = localPluginContext.SystemUserService;
            var userService = localPluginContext.CurrentUserService;
            var trace = localPluginContext.TracingService;

            var tableName = GetString(context, "TableName");
            if (string.IsNullOrWhiteSpace(tableName))
                throw new InvalidPluginExecutionException("asx_RunRules: TableName is required.");

            var recordIdRaw = GetString(context, "RecordId");
            var recordJson = GetString(context, "RecordJson");
            var triggersRaw = GetString(context, "Triggers");

            var trigger = ParseTrigger(triggersRaw);
            var (input, mode) = BuildInput(tableName, recordIdRaw, recordJson);

            var languageId = LanguageResolver.Resolve(systemService, context.InitiatingUserId);
            var context2 = localPluginContext.PluginExecutionContext2;
            var channel = context2 != null
                ? OriginResolver.Resolve(context2.IsPortalsClientCall)
                : RuleChannel.Standard;
            trace.Trace($"Resolved origin channel: {channel} (portal={context2?.IsPortalsClientCall ?? false}).");

            var outcome = new RulesEngineRunner().Run(
                systemService, userService, tableName, new List<RootInput> { input },
                trigger, channel, languageId, mode, trace);

            context.OutputParameters["IsValid"] = outcome.IsValid;
            context.OutputParameters["FailedRuleCount"] = outcome.FailedRuleCount;
            context.OutputParameters["Results"] = RunRulesResultSerializer.Serialize(outcome);

            if (GetBool(context, "IncludeDiagnostics") && outcome.Diagnostics != null)
                context.OutputParameters["Diagnostics"] =
                    Ascentix.RulesEngine.Core.Diagnostics.RunDiagnosticsSerializer.Serialize(outcome.Diagnostics);
        }

        private static string GetString(IPluginExecutionContext context, string name)
            => context.InputParameters.TryGetValue(name, out var v) ? v as string : null;

        private static bool GetBool(IPluginExecutionContext context, string name)
            => context.InputParameters.TryGetValue(name, out var v) && v is bool b && b;

        // Default Manual; case-insensitive; unknown → argument error.
        private static RuleTrigger ParseTrigger(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return RuleTrigger.Manual;
            if (Enum.TryParse<RuleTrigger>(raw.Trim(), ignoreCase: true, out var trigger))
                return trigger;
            throw new InvalidPluginExecutionException(
                $"asx_RunRules: unknown Triggers value '{raw}'. Expected one of " +
                "OnCreate, OnForm, Manual, OnUpdate, OnDelete.");
        }

        // RecordId only → RetrieveOnly; RecordJson only → UseTarget; both → RetrieveAndOverlay.
        private static (RootInput Input, RootBuildMode Mode) BuildInput(
            string tableName, string recordIdRaw, string recordJson)
        {
            var hasId = !string.IsNullOrWhiteSpace(recordIdRaw);
            var hasJson = !string.IsNullOrWhiteSpace(recordJson);

            if (!hasId && !hasJson)
                throw new InvalidPluginExecutionException(
                    "asx_RunRules: supply at least one of RecordId or RecordJson.");

            var id = Guid.Empty;
            if (hasId && !Guid.TryParse(recordIdRaw, out id))
                throw new InvalidPluginExecutionException(
                    $"asx_RunRules: RecordId '{recordIdRaw}' is not a valid GUID.");

            Entity overlay = null;
            if (hasJson)
            {
                overlay = RecordJsonDeserializer.Deserialize(tableName, recordJson);
                if (hasId) overlay.Id = id;
            }

            if (hasId && hasJson) return (new RootInput { Id = id, Overlay = overlay }, RootBuildMode.RetrieveAndOverlay);
            if (hasId) return (new RootInput { Id = id, Overlay = null }, RootBuildMode.RetrieveOnly);
            return (new RootInput { Id = overlay.Id, Overlay = overlay }, RootBuildMode.UseTarget);
        }
    }
}
