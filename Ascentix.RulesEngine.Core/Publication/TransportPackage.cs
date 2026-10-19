using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Core.Publication
{
    /// <summary>The schedule definition of a rule. Run state (next run, last run, last outcome) is never carried.</summary>
    [DataContract]
    public sealed class TransportSchedule
    {
        [DataMember] public bool On { get; set; }
        [DataMember] public int? Pattern { get; set; }
        [DataMember] public int? Every { get; set; }
        [DataMember] public string TimeOfDay { get; set; }
        /// <summary>The weekday choice values (0-6), ascending and comma separated.</summary>
        [DataMember] public string DaysOfWeek { get; set; }
        [DataMember] public int? DayOfMonth { get; set; }
    }

    /// <summary>A record id a rule stores in its configuration: it names a record in the source environment, not a model node.</summary>
    [DataContract]
    public sealed class RecordReference
    {
        /// <summary>The table of the configuration row that holds the id.</summary>
        [DataMember] public string RowEntity { get; set; }
        [DataMember] public Guid RowId { get; set; }
        /// <summary>The column that holds the id.</summary>
        [DataMember] public string Attribute { get; set; }
        [DataMember] public Guid RecordId { get; set; }
        /// <summary>The tables the record can belong to; empty when they could not be determined.</summary>
        [DataMember] public List<string> Tables { get; set; } = new List<string>();
    }

    /// <summary>One published rule, packaged for another environment.</summary>
    [DataContract]
    public sealed class TransportEntry
    {
        [DataMember] public int Format { get; set; } = 1;
        [DataMember] public string EngineVersion { get; set; }
        [DataMember] public Guid Id { get; set; }
        [DataMember] public string Name { get; set; }
        [DataMember] public string RuleSet { get; set; }
        [DataMember] public int Version { get; set; }
        [DataMember] public string Hash { get; set; }
        [DataMember] public RuleSnapshot Definition { get; set; }
        [DataMember] public TransportSchedule Schedule { get; set; }
        [DataMember] public List<RecordReference> RecordReferences { get; set; } = new List<RecordReference>();

        public string Serialize()
        {
            using (var stream = new MemoryStream())
            {
                new DataContractJsonSerializer(typeof(TransportEntry)).WriteObject(stream, this);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }

        public static TransportEntry Parse(string json)
        {
            try
            {
                using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(json ?? "")))
                {
                    var value = (TransportEntry)new DataContractJsonSerializer(typeof(TransportEntry)).ReadObject(stream);
                    if (value == null || value.Format != 1 || value.Definition == null)
                        throw new SerializationException("Invalid entry.");
                    if (value.RecordReferences == null) value.RecordReferences = new List<RecordReference>();
                    return value;
                }
            }
            catch (Exception e) when (!(e is InvalidPluginExecutionException))
            { throw new InvalidPluginExecutionException("The rule package entry cannot be read.", e); }
        }

        /// <summary>The installed AscentixRulesEngine solution version (the assembly version is fixed for strong-name stability).</summary>
        public static string InstalledEngineVersion(IOrganizationService service)
        {
            var query = new QueryExpression("solution") { ColumnSet = new ColumnSet("version"), TopCount = 1 };
            query.Criteria.AddCondition("uniquename", ConditionOperator.Equal, "AscentixRulesEngine");
            var version = service.RetrieveMultiple(query).Entities.FirstOrDefault()?.GetAttributeValue<string>("version");
            if (string.IsNullOrEmpty(version))
                throw new InvalidPluginExecutionException("The installed Rules Engine solution version could not be found.");
            return version;
        }
    }
}
