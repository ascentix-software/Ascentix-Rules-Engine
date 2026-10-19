using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Publication;

namespace Ascentix.RulesEngine.Plugin
{
    // Main-operation handler for moving rules between environments. One rule per call.
    public sealed class RuleTransportApi : PluginBase
    {
        public RuleTransportApi() : base(typeof(RuleTransportApi)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            var context = local.PluginExecutionContext;
            switch (context.MessageName)
            {
                case "asx_ExportRule":
                    Export(local);
                    break;
                default:
                    throw new InvalidPluginExecutionException("Unknown rule transport operation.");
            }
        }

        private static Guid RuleId(IPluginExecutionContext context)
        {
            if (!context.InputParameters.TryGetValue("RuleId", out var raw) || !Guid.TryParse(raw as string, out var ruleId))
                throw new InvalidPluginExecutionException("RuleId is required.");
            return ruleId;
        }

        private static void Export(ILocalPluginContext local)
        {
            var context = local.PluginExecutionContext;
            var service = local.SystemUserService;
            var header = service.Retrieve("asx_rule", RuleId(context), new ColumnSet(true));
            context.OutputParameters["Entry"] = BuildEntry(service, header).Serialize();
        }

        public static TransportEntry BuildEntry(IOrganizationService service, Entity header)
        {
            if (header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf) != null)
                throw new InvalidPluginExecutionException("This is a working draft; only published rules can be exported.");
            var status = header.GetAttributeValue<OptionSetValue>("statuscode")?.Value;
            if (status != 753840000)
                throw new InvalidPluginExecutionException(status == 2
                    ? "This rule is archived; only published rules can be exported."
                    : "This rule is not published; only published rules can be exported.");

            // The revision is what enforces, not the live rows (which a working draft may have moved on from).
            var definition = PublishedRules.Read(service, header);
            string hash;
            if (definition != null)
                hash = service.Retrieve(PublicationSchema.Revision, header.GetAttributeValue<EntityReference>(PublicationSchema.Pointer).Id,
                    new ColumnSet("asx_hash")).GetAttributeValue<string>("asx_hash");
            else
            {
                definition = RuleSnapshot.Capture(service, header.Id);
                hash = definition.Hash();
            }

            var cache = new Dictionary<string, List<string>>();
            List<string> LookupTargets(string table, string column)
            {
                var key = table + "." + column;
                if (!cache.TryGetValue(key, out var targets))
                    cache[key] = targets = Targets(service, table, column);
                return targets;
            }

            return new TransportEntry
            {
                EngineVersion = TransportEntry.EngineVersionOf(typeof(RuleTransportApi)),
                Id = header.Id,
                Name = header.GetAttributeValue<string>("asx_name"),
                RuleSet = RuleSetName(service, header),
                Version = header.GetAttributeValue<int>(PublicationSchema.Number),
                Hash = hash,
                Definition = definition,
                Schedule = Schedule(service, header.Id),
                RecordReferences = RecordReferenceScanner.Find(definition, LookupTargets)
            };
        }

        private static string RuleSetName(IOrganizationService service, Entity header)
        {
            var set = header.GetAttributeValue<EntityReference>(PublicationSchema.RuleSet);
            return set == null ? null : service.Retrieve(set.LogicalName, set.Id, new ColumnSet("asx_name")).GetAttributeValue<string>("asx_name");
        }

        // Definition only: when it next runs and what it last did belong to the environment it runs in.
        private static TransportSchedule Schedule(IOrganizationService service, Guid ruleId)
        {
            var query = new QueryExpression("asx_ruleschedule") { TopCount = 1,
                ColumnSet = new ColumnSet("asx_on", "asx_pattern", "asx_every", "asx_timeofday", "asx_daysofweek", "asx_dayofmonth") };
            query.Criteria.AddCondition("asx_rule", ConditionOperator.Equal, ruleId);
            var row = service.RetrieveMultiple(query).Entities.FirstOrDefault();
            if (row == null) return null;
            var days = row.GetAttributeValue<OptionSetValueCollection>("asx_daysofweek");
            return new TransportSchedule
            {
                On = row.GetAttributeValue<bool>("asx_on"),
                Pattern = row.GetAttributeValue<OptionSetValue>("asx_pattern")?.Value,
                Every = row.GetAttributeValue<int?>("asx_every"),
                TimeOfDay = row.GetAttributeValue<string>("asx_timeofday"),
                DaysOfWeek = days == null || days.Count == 0 ? null : string.Join(",", days.Select(d => d.Value).OrderBy(d => d)),
                DayOfMonth = row.GetAttributeValue<int?>("asx_dayofmonth")
            };
        }

        // The tables a lookup column can point at; empty for a column that is not a lookup (or is not found).
        private static List<string> Targets(IOrganizationService service, string table, string column)
        {
            try
            {
                var response = (RetrieveAttributeResponse)service.Execute(new RetrieveAttributeRequest {
                    EntityLogicalName = table, LogicalName = column, RetrieveAsIfPublished = true });
                return (response.AttributeMetadata as LookupAttributeMetadata)?.Targets?.ToList() ?? new List<string>();
            }
            catch (System.ServiceModel.FaultException) { return new List<string>(); }
        }
    }
}
