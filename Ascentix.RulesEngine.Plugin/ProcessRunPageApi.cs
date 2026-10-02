using System;
using System.Diagnostics;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Localization;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Main-operation handler for the unbound asx_ProcessRunPage Custom API. Advances one Rule Run
    /// by a page (see <see cref="RunPageProcessor"/>) and reports its status and running totals.
    /// IncludeDiagnostics (input) opts into the Diagnostics (output) JSON for this call.
    /// </summary>
    public class ProcessRunPageApi : PluginBase
    {
        public ProcessRunPageApi() : base(typeof(ProcessRunPageApi)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            if (local == null) throw new ArgumentNullException(nameof(local));
            var overall = Stopwatch.StartNew();

            var context = local.PluginExecutionContext;
            var system = local.SystemUserService;

            var runId = OptionalGuid(context, SchemaNames.ProcessRunPageApi.ParamRunId)
                ?? throw new InvalidPluginExecutionException($"asx_ProcessRunPage: {SchemaNames.ProcessRunPageApi.ParamRunId} is required.");
            var failedRecordId = OptionalGuid(context, SchemaNames.ProcessRunPageApi.ParamFailedRecordId);
            var failedMessage = context.InputParameters.TryGetValue(SchemaNames.ProcessRunPageApi.ParamFailedMessage, out var message)
                ? message as string
                : null;
            var languageId = LanguageResolver.Resolve(system, context.InitiatingUserId);

            // Only built when asked for: RunPageProcessor's diagnostics hooks are all null-guarded,
            // so with IncludeDiagnostics false the page runs exactly as before this feature.
            var diagnostics = DiagnosticsOutput.Requested(context, SchemaNames.ProcessRunPageApi.ParamIncludeDiagnostics)
                ? new RunDiagnostics()
                : null;
            var result = new RunPageProcessor(system, local.CurrentUserService, languageId, local.TracingService,
                    PluginReentry.IsEngineInitiated(context), new RunPageLimits(), () => DateTime.UtcNow, diagnostics)
                .Process(runId, failedRecordId, failedMessage);
            if (diagnostics != null) diagnostics.TotalMs = overall.ElapsedMilliseconds;

            context.OutputParameters[SchemaNames.ProcessRunPageApi.PropDone] = result.Done;
            context.OutputParameters[SchemaNames.ProcessRunPageApi.PropStatus] = (int)result.Status;
            context.OutputParameters[SchemaNames.ProcessRunPageApi.PropEvaluated] = result.Evaluated;
            context.OutputParameters[SchemaNames.ProcessRunPageApi.PropChanged] = result.Changed;
            context.OutputParameters[SchemaNames.ProcessRunPageApi.PropBlocked] = result.Blocked;
            context.OutputParameters[SchemaNames.ProcessRunPageApi.PropFailed] = result.Failed;
            context.OutputParameters[SchemaNames.ProcessRunPageApi.PropSkipped] = result.Skipped;
            DiagnosticsOutput.SetIfRequested(context, SchemaNames.ProcessRunPageApi.ParamIncludeDiagnostics,
                SchemaNames.ProcessRunPageApi.PropDiagnostics, diagnostics);
        }

        // The Custom API declares the ids as Guid parameters, but tests (and some callers) may
        // pass a parseable string instead, so both are accepted. An empty Guid means not given.
        private static Guid? OptionalGuid(IPluginExecutionContext context, string name)
        {
            if (context.InputParameters.TryGetValue(name, out var raw))
            {
                if (raw is Guid g && g != Guid.Empty) return g;
                if (raw is string s && Guid.TryParse(s, out var parsed) && parsed != Guid.Empty) return parsed;
            }
            return null;
        }
    }
}
