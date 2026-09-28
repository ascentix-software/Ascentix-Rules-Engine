using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>A rule that is runnable on demand: its published header plus the trigger-resolved
    /// bits a Rule Run needs (asx_rulerun creation, then asx_ProcessRunPage).</summary>
    public sealed class OnDemandRule
    {
        public OnDemandRule(Guid ruleId, string table, string name, OnDemandScope scope, Guid? publishedRevisionId)
        {
            RuleId = ruleId;
            Table = table;
            Name = name;
            Scope = scope;
            PublishedRevisionId = publishedRevisionId;
        }

        public Guid RuleId { get; }
        public string Table { get; }
        public string Name { get; }
        public OnDemandScope Scope { get; }
        public Guid? PublishedRevisionId { get; }
    }

    /// <summary>Resolves whether a rule is runnable on demand: published (or a legacy live rule),
    /// tagged with the On demand trigger, and in its effective window.</summary>
    public static class OnDemandRules
    {
        public static OnDemandRule Resolve(IOrganizationService systemService, Guid ruleId, ITracingService trace)
        {
            Entity header;
            try
            {
                header = systemService.Retrieve(SchemaNames.Qualify(SchemaNames.Rule.Entity), ruleId,
                    new ColumnSet(SchemaNames.Qualify(SchemaNames.Rule.TableLogicalName), SchemaNames.Qualify(SchemaNames.PrimaryName),
                        SchemaNames.Qualify(SchemaNames.Rule.PublishedRevision)));
            }
            catch (Exception e) when (!(e is InvalidPluginExecutionException))
            {
                throw new InvalidPluginExecutionException($"Rule {ruleId} was not found.");
            }

            var table = header.GetAttributeValue<string>(SchemaNames.Qualify(SchemaNames.Rule.TableLogicalName));
            var buckets = RuleBuckets.Load(systemService, table, RuleTrigger.OnDemand, RuleChannel.Standard,
                new RunDiagnostics(), trace, new RuleSelection { RuleId = ruleId, AnyChannel = true });
            var rule = buckets.SelectMany(b => b.Rules).FirstOrDefault(r => r.Id == ruleId);
            if (rule == null)
                throw new InvalidPluginExecutionException("The rule is not published with the On demand trigger.");

            var scope = rule.GetAttributeValue<OptionSetValue>(SchemaNames.Qualify(SchemaNames.Rule.OnDemandScope))?.Value;
            return new OnDemandRule(ruleId, table, header.GetAttributeValue<string>(SchemaNames.Qualify(SchemaNames.PrimaryName)),
                scope == (int)OnDemandScope.AllRecords ? OnDemandScope.AllRecords : OnDemandScope.GivenRecord,
                header.GetAttributeValue<EntityReference>(SchemaNames.Qualify(SchemaNames.Rule.PublishedRevision))?.Id);
        }
    }
}
