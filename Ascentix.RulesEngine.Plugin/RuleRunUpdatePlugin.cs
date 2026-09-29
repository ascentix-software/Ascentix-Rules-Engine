using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Pre-operation, Update of asx_rulerun. A run's scope, record ids, counts and bookmark are
    /// the engine's to keep: outside asx_ProcessRunPage the only change allowed is cancelling a
    /// queued or running run (asx_status to Cancelled), so a caller with Write on the table can't
    /// rewrite a run to get around its rule's Runs for setting.
    /// </summary>
    public sealed class RuleRunUpdatePlugin : PluginBase
    {
        public const string OnlyCancelMessage = "Only cancelling a run is allowed.";

        private static string Q(string fragment) => SchemaNames.Qualify(fragment);

        // Columns the platform adds to every Update's Target; they are never the caller's edit.
        private static readonly HashSet<string> SystemColumns = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "modifiedon", "modifiedby", "modifiedonbehalfby",
        };

        public RuleRunUpdatePlugin() : base(typeof(RuleRunUpdatePlugin)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            var context = local.PluginExecutionContext;

            // The page processor's own saves. A parent context can't be supplied by a Web API
            // caller (unlike the 'tag' shared variable), so this can't be spoofed from outside.
            if (IsInsideProcessRunPage(context)) return;

            var target = context.InputParameters.TryGetValue("Target", out var input) ? input as Entity : null;
            if (target == null) return;

            var status = Q(SchemaNames.RuleRun.Status);
            var edited = target.Attributes.Keys
                .Where(k => !SystemColumns.Contains(k) && k != Q(SchemaNames.RuleRun.Entity) + "id")
                .ToList();
            if (edited.Count == 0) return;
            if (edited.Count != 1 || edited[0] != status
                || target.GetAttributeValue<OptionSetValue>(status)?.Value != (int)RuleRunStatus.Cancelled)
                throw new InvalidPluginExecutionException(OnlyCancelMessage);

            var current = local.SystemUserService.Retrieve(Q(SchemaNames.RuleRun.Entity), target.Id, new ColumnSet(status))
                .GetAttributeValue<OptionSetValue>(status)?.Value;
            if (current != (int)RuleRunStatus.Queued && current != (int)RuleRunStatus.Running)
                throw new InvalidPluginExecutionException(OnlyCancelMessage);
        }

        private static bool IsInsideProcessRunPage(IPluginExecutionContext context)
        {
            var message = Q(SchemaNames.ProcessRunPageApi.MessageName);
            for (var ctx = context.ParentContext; ctx != null; ctx = ctx.ParentContext)
                if (string.Equals(ctx.MessageName, message, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
    }
}
