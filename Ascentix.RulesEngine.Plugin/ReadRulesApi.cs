using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Localization;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Main-operation handler for the unbound asx_ReadRules Custom API (a read-only Function).
    /// Returns the rule definitions for a table as the Rules JSON envelope. Loads + serializes,
    /// never evaluates. Throws only on argument/usage errors. Config reads use the system service;
    /// the caller must hold the Plan 2F Rules Engine Reader role.
    /// </summary>
    public class ReadRulesApi : PluginBase
    {
        public ReadRulesApi() : base(typeof(ReadRulesApi)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null) throw new ArgumentNullException(nameof(localPluginContext));

            var context = localPluginContext.PluginExecutionContext;
            var systemService = localPluginContext.SystemUserService;
            var trace = localPluginContext.TracingService;

            var tableName = GetString(context, "TableName");
            if (string.IsNullOrWhiteSpace(tableName))
                throw new InvalidPluginExecutionException("asx_ReadRules: TableName is required.");

            var trigger = ParseTrigger(GetString(context, "Triggers"));

            var languageId = LanguageResolver.Resolve(systemService, context.InitiatingUserId);
            var context2 = localPluginContext.PluginExecutionContext2;
            var channel = context2 != null
                ? OriginResolver.Resolve(context2.IsPortalsClientCall)
                : RuleChannel.Standard;
            trace.Trace($"Resolved origin channel: {channel} (portal={context2?.IsPortalsClientCall ?? false}).");

            var rules = new RuleLoader(systemService).LoadRules(tableName, trigger, channel);
            var nowUtc = DateTime.UtcNow;
            rules = rules.Where(r => RuleScheduleFilter.IsInEffect(r, nowUtc)).ToList();
            trace.Trace($"asx_ReadRules: {rules.Count} in-effect {trigger} rules for '{tableName}'.");

            var rootGroups = new ConditionGroupMapper().MapConditionGroups(rules);

            var nodeIds = RuleReferences.Compute(rootGroups, null)
                .NodeIds(ReferenceKind.ConditionNodes, ReferenceKind.FieldReferenceNodes)
                .Cast<object>().ToArray();
            var tree = nodeIds.Length > 0
                ? new TableConfigLoader(systemService).LoadConfigs(nodeIds)
                : TableConfigTree.Empty;

            var actionsByRule = rules.Any()
                ? new RuleActionLoader(systemService).LoadActionsByRule(rules.Select(r => r.Id))
                : new Dictionary<Guid, List<RuleAction>>();

            context.OutputParameters["Rules"] = RuleDefinitionSerializer.Serialize(
                tableName, languageId, rules, rootGroups, tree, actionsByRule);
        }

        private static string GetString(IPluginExecutionContext context, string name)
            => context.InputParameters.TryGetValue(name, out var v) ? v as string : null;

        // Default OnForm; case-insensitive; unknown → argument error.
        private static RuleTrigger ParseTrigger(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return RuleTrigger.OnForm;
            if (Enum.TryParse<RuleTrigger>(raw.Trim(), ignoreCase: true, out var trigger))
                return trigger;
            throw new InvalidPluginExecutionException(
                $"asx_ReadRules: unknown Triggers value '{raw}'. Expected one of " +
                "OnCreate, OnForm, Manual, OnUpdate, OnDelete.");
        }
    }
}
