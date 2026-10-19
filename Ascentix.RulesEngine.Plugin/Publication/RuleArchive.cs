using System;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Publication;

namespace Ascentix.RulesEngine.Plugin.Publication
{
    /// <summary>What archiving one rule did. Outcome: archived or alreadyArchived.</summary>
    [DataContract]
    public sealed class ArchiveResult
    {
        [DataMember] public Guid RuleId { get; set; }
        [DataMember] public string Name { get; set; }
        [DataMember] public string Outcome { get; set; }

        public string Serialize()
        {
            using (var stream = new MemoryStream())
            {
                new DataContractJsonSerializer(typeof(ArchiveResult)).WriteObject(stream, this);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }
    }

    /// <summary>Archives a rule on the server so a package import can retire rules the package no longer carries.</summary>
    public static class RuleArchive
    {
        private const int Archived = 2;

        public static ArchiveResult Run(IPluginExecutionContext context, IOrganizationService service, Guid ruleId)
        {
            var header = service.Retrieve("asx_rule", ruleId, new ColumnSet(true));
            if (header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf) != null)
                throw new InvalidPluginExecutionException("This is a working draft; only a rule can be archived.");
            var result = new ArchiveResult { RuleId = ruleId, Name = header.GetAttributeValue<string>("asx_name"), Outcome = "alreadyArchived" };
            if (header.GetAttributeValue<OptionSetValue>("statuscode")?.Value == Archived) return result;
            // Internal bypasses the revision guard; reconcile lets the registration plug-in remove the enforcement steps.
            PublicationCoordinator.Internal(context, service, writer => writer.Update(new Entity("asx_rule", ruleId) {
                ["statuscode"] = new OptionSetValue(Archived) }), reconcile: true);
            result.Outcome = "archived";
            return result;
        }
    }
}
