using System;
using Ascentix.RulesEngine.Plugin.DataUpdates;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// asx_ApplyDataUpdates (docs/Schema.md §10). Mode = Status reports the data updates this release
    /// carries and which are pending (any caller with rule read). Mode = Apply runs the pending ones,
    /// one budget per call (System Administrator / System Customizer only); the caller re-calls until
    /// Done, re-calling after an item-failed error with FailedItem = the error's failed-item token
    /// (&lt;number&gt;/&lt;item&gt;, sent back exactly as received) and FailedMessage.
    /// </summary>
    public class ApplyDataUpdatesApi : PluginBase
    {
        public const string NotAdminMessage =
            "asx_ApplyDataUpdates: only a System Administrator or System Customizer can apply data updates.";

        public ApplyDataUpdatesApi() : base(typeof(ApplyDataUpdatesApi)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext localPluginContext)
        {
            var context = localPluginContext.PluginExecutionContext;
            var system = localPluginContext.SystemUserService;

            var mode = (Input(context, SchemaNames.ApplyDataUpdatesApi.ParamMode) as string)?.Trim();
            var isStatus = string.Equals(mode, "Status", StringComparison.OrdinalIgnoreCase);
            var isApply = string.Equals(mode, "Apply", StringComparison.OrdinalIgnoreCase);
            if (!isStatus && !isApply)
                throw new InvalidPluginExecutionException($"asx_ApplyDataUpdates: unknown Mode '{mode}'. Expected Status or Apply.");

            var canApply = AdminPrivilege.Has(system, context.InitiatingUserId);
            var processor = new DataUpdateProcessor(system, localPluginContext.TracingService, context.InitiatingUserId,
                DataUpdateRegistry.All, new DataUpdateLimits(), () => DateTime.UtcNow);

            DataUpdateResult result;
            if (isStatus)
            {
                result = processor.Status(canApply);
            }
            else
            {
                if (!canApply) throw new InvalidPluginExecutionException(NotAdminMessage);
                // Dataverse passes an optional Integer the caller left out as 0; update numbers start at 1.
                var retry = Input(context, SchemaNames.ApplyDataUpdatesApi.ParamRetry) as int?;
                if (retry <= 0) retry = null;
                var failedItem = Input(context, SchemaNames.ApplyDataUpdatesApi.ParamFailedItem) as string;
                var failedMessage = Input(context, SchemaNames.ApplyDataUpdatesApi.ParamFailedMessage) as string;
                result = processor.Apply(retry, string.IsNullOrWhiteSpace(failedItem) ? null : failedItem.Trim(), failedMessage);
            }

            context.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropRequired] = result.Required;
            context.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropPending] = DataUpdateRows.WritePending(result.Pending);
            context.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropLatest] = result.Latest == null ? "null" : DataUpdateRows.WriteLatest(result.Latest);
            context.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropCanApply] = result.CanApply;
            context.OutputParameters[SchemaNames.ApplyDataUpdatesApi.PropDone] = result.Done;
        }

        private static object Input(IPluginExecutionContext context, string name) =>
            context.InputParameters.TryGetValue(name, out var value) ? value : null;
    }
}
