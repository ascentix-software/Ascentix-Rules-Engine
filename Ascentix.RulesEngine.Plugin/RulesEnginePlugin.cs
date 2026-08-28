using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Localization;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Dataverse plugin entry point. Registered (via Plan 2C) on Create/CreateMultiple,
    /// Update/UpdateMultiple, and Delete. Normalizes Target/Targets/(delete)EntityReference into
    /// root inputs, delegates evaluation to the shared <see cref="RulesEngineRunner"/>, and
    /// throws once aggregating all fired Block messages (the enforcing adapter).
    /// </summary>
    public class RulesEnginePlugin : PluginBase
    {
        public RulesEnginePlugin() : base(typeof(RulesEnginePlugin)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null) throw new ArgumentNullException(nameof(localPluginContext));

            var context = localPluginContext.PluginExecutionContext;
            var systemService = localPluginContext.SystemUserService;
            var userService = localPluginContext.CurrentUserService;
            var trace = localPluginContext.TracingService;

            var languageId = LanguageResolver.Resolve(systemService, context.InitiatingUserId);
            trace.Trace($"Render language: {languageId}.");

            var context2 = localPluginContext.PluginExecutionContext2;
            var channel = context2 != null
                ? OriginResolver.Resolve(context2.IsPortalsClientCall)
                : RuleChannel.Standard;
            trace.Trace($"Resolved origin channel: {channel} (portal={context2?.IsPortalsClientCall ?? false}).");

            var trigger = TriggerForMessage(context.MessageName);
            var mode = BuildModeForMessage(context.MessageName);

            if (!TryNormalizeInputs(context, out var logicalName, out var inputs))
            {
                trace.Trace("No Target/Targets to evaluate.");
                return;
            }
            trace.Trace($"{context.MessageName}: {inputs.Count} record(s) of '{logicalName}'.");

            var outcome = new RulesEngineRunner().Run(
                systemService, userService, logicalName, inputs,
                trigger, channel, languageId, mode, trace);

            var failed = outcome.Records.Where(r => r.HasBlock).ToList();
            if (failed.Count > 0)
            {
                var allMessages = failed.SelectMany(r => r.BlockingMessages);
                var details = new Dictionary<string, string>();
                var idx = 0;
                foreach (var f in failed)
                    details["failedRecordId_" + idx++] = f.RecordId.ToString();

                throw new InvalidPluginExecutionException(
                    ActionDispatcher.FormatBlockMessage(allMessages, languageId), details);
            }

            // No block, so apply any fired write actions (atomic, depth-guarded).
            var writeTargets = inputs
                .Select(inp => new WriteTarget { RecordId = inp.Id, InPlace = inp.Overlay })
                .ToList();

            new WriteActionExecutor().Execute(
                outcome, writeTargets, userService, systemService,
                PluginReentry.IsEngineInitiated(context), trace);
        }

        // ── Input normalization (Target/Targets/EntityReference) ────────────────

        private static bool TryNormalizeInputs(
            IPluginExecutionContext context, out string logicalName, out List<RootInput> inputs)
        {
            logicalName = null;
            inputs = new List<RootInput>();

            if (context.InputParameters.TryGetValue("Targets", out var targetsObj)
                && targetsObj is EntityCollection collection && collection.Entities.Count > 0)
            {
                logicalName = collection.Entities[0].LogicalName;
                inputs = collection.Entities
                    .Select(e => new RootInput { Id = e.Id, Overlay = e }).ToList();
                return true;
            }

            if (context.InputParameters.TryGetValue("Target", out var targetObj))
            {
                if (targetObj is Entity entity)
                {
                    logicalName = entity.LogicalName;
                    inputs.Add(new RootInput { Id = entity.Id, Overlay = entity });
                    return true;
                }
                if (targetObj is EntityReference reference)
                {
                    logicalName = reference.LogicalName;
                    inputs.Add(new RootInput { Id = reference.Id, Overlay = null });
                    return true;
                }
            }

            return false;
        }

        private static RootBuildMode BuildModeForMessage(string messageName)
        {
            switch (messageName)
            {
                case "Create":
                case "CreateMultiple": return RootBuildMode.UseTarget;
                case "Update":
                case "UpdateMultiple": return RootBuildMode.RetrieveAndOverlay;
                case "Delete": return RootBuildMode.RetrieveOnly;
                default:
                    throw new InvalidPluginExecutionException(
                        $"RulesEnginePlugin is not registered for message '{messageName}'.");
            }
        }

        private static RuleTrigger TriggerForMessage(string messageName)
        {
            switch (messageName)
            {
                case "Create":
                case "CreateMultiple": return RuleTrigger.OnCreate;
                case "Update":
                case "UpdateMultiple": return RuleTrigger.OnUpdate;
                case "Delete": return RuleTrigger.OnDelete;
                default:
                    throw new InvalidPluginExecutionException(
                        $"RulesEnginePlugin is not registered for message '{messageName}'.");
            }
        }
    }
}
