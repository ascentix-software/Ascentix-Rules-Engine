using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Core.Publication
{
    public static class PublicationSchema
    {
        public const string Revision = "asx_rulerevision";
        public const string Pointer = "asx_publishedrevision";
        public const string Number = "asx_publishedversion";
        public const string PublishHash = "asx_publishhash";
        public const string DraftStamp = "asx_draftstamp";
        public const string Lock = "asx_publicationlock";
        public static readonly Guid LockId = new Guid("7e0d7362-c0fd-44ab-a8a1-aecb70d86a79");
        public static readonly string[] ConfigTables = { "asx_rule", "asx_conditiongroup", "asx_rulecondition",
            "asx_searchcriteriagroup", "asx_searchcriterion", "asx_nodefiltergroup", "asx_nodefiltercriterion",
            "asx_ruleaction", "asx_localizedmessage", "asx_tableconfig" };
        public static bool IsConfig(string entity) => ConfigTables.Contains(entity);
        public static bool IsProtected(string field) => field == Pointer || field == Number || field == DraftStamp;
    }

    [DataContract]
    public sealed class SnapshotValue
    {
        [DataMember] public string Kind { get; set; }
        [DataMember] public string Value { get; set; }
        [DataMember(EmitDefaultValue = false)] public string Entity { get; set; }

        public static SnapshotValue From(object value)
        {
            if (value == null) return new SnapshotValue { Kind = "null" };
            if (value is EntityReference r) return new SnapshotValue { Kind = "reference", Value = r.Id.ToString(), Entity = r.LogicalName };
            if (value is OptionSetValue o) return new SnapshotValue { Kind = "option", Value = o.Value.ToString(CultureInfo.InvariantCulture) };
            if (value is OptionSetValueCollection os) return new SnapshotValue { Kind = "options", Value = string.Join(",", os.Select(x => x.Value).OrderBy(x => x)) };
            if (value is DateTime dt) return new SnapshotValue { Kind = "date", Value =
                (dt.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(dt, DateTimeKind.Utc) : dt.ToUniversalTime()).ToString("O") };
            if (value is Money money) return new SnapshotValue { Kind = "money", Value = money.Value.ToString(CultureInfo.InvariantCulture) };
            var kind = value is string ? "string" : value is Guid ? "guid" : value is bool ? "bool" :
                value is int ? "int" : value is long ? "long" : value is decimal ? "decimal" : value is double ? "double" : null;
            if (kind == null) throw new InvalidPluginExecutionException("Unsupported published value: " + value.GetType().Name);
            return new SnapshotValue { Kind = kind, Value = Convert.ToString(value, CultureInfo.InvariantCulture) };
        }

        public object ToSdk()
        {
            switch (Kind)
            {
                case "null": return null;
                case "reference": return new EntityReference(Entity, Guid.Parse(Value));
                case "option": return new OptionSetValue(int.Parse(Value, CultureInfo.InvariantCulture));
                case "options": return new OptionSetValueCollection((Value ?? "").Split(',').Where(x => x.Length > 0).Select(x => new OptionSetValue(int.Parse(x, CultureInfo.InvariantCulture))).ToList());
                case "date": return DateTime.Parse(Value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
                case "money": return new Money(decimal.Parse(Value, CultureInfo.InvariantCulture));
                case "guid": return Guid.Parse(Value);
                case "bool": return bool.Parse(Value);
                case "int": return int.Parse(Value, CultureInfo.InvariantCulture);
                case "long": return long.Parse(Value, CultureInfo.InvariantCulture);
                case "decimal": return decimal.Parse(Value, CultureInfo.InvariantCulture);
                case "double": return double.Parse(Value, CultureInfo.InvariantCulture);
                case "string": return Value;
                default: throw new InvalidPluginExecutionException("Unknown published value type.");
            }
        }
    }

    [DataContract]
    public sealed class SnapshotRow
    {
        [DataMember] public string Entity { get; set; }
        [DataMember] public Guid Id { get; set; }
        [DataMember] public Dictionary<string, SnapshotValue> Attributes { get; set; }
        public Microsoft.Xrm.Sdk.Entity ToSdk()
        {
            var row = new Microsoft.Xrm.Sdk.Entity(Entity, Id);
            foreach (var a in Attributes) row[a.Key] = a.Value.ToSdk();
            return row;
        }
    }

    [DataContract]
    public sealed class RuleSnapshot
    {
        [DataMember] public int Format { get; set; } = 1;
        [DataMember] public Guid RuleId { get; set; }
        [DataMember] public List<SnapshotRow> Rows { get; set; } = new List<SnapshotRow>();
        public string Serialize()
        {
            using (var stream = new MemoryStream())
            {
                new DataContractJsonSerializer(typeof(RuleSnapshot)).WriteObject(stream, this);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }
        public static RuleSnapshot Parse(string json, Guid ruleId)
        {
            try
            {
                using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(json ?? "")))
                {
                    var value = (RuleSnapshot)new DataContractJsonSerializer(typeof(RuleSnapshot)).ReadObject(stream);
                    if (value.Format != 1 || value.RuleId != ruleId || value.Rows == null ||
                        value.Rows.Count(r => r.Entity == "asx_rule" && r.Id == ruleId) != 1 ||
                        value.Rows.Any(r => !PublicationSchema.IsConfig(r.Entity) || r.Attributes == null) ||
                        value.Rows.GroupBy(r => r.Entity + r.Id).Any(g => g.Count() != 1))
                        throw new SerializationException("Invalid revision structure.");
                    return value;
                }
            }
            catch (Exception e) when (!(e is InvalidPluginExecutionException))
            { throw new InvalidPluginExecutionException("The published rule revision cannot be read. Its draft was not used as a fallback.", e); }
        }
        public string Hash()
        {
            using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Serialize()))).Replace("-", "").ToLowerInvariant();
        }

        public static RuleSnapshot Capture(IOrganizationService service, Guid ruleId, bool includeConfigs = true)
        {
            var result = new RuleSnapshot { RuleId = ruleId };
            var pending = new Queue<Entity>();
            var seen = new HashSet<string>();
            pending.Enqueue(service.Retrieve("asx_rule", ruleId, new ColumnSet(true)));
            if (includeConfigs)
            {
                var candidate = Validation.RuleValidationLoader.Load(service, ruleId);
                foreach (var node in candidate.Configs.Nodes)
                    pending.Enqueue(service.Retrieve("asx_tableconfig", node.Id, new ColumnSet(true)));
            }
            while (pending.Count > 0)
            {
                var row = pending.Dequeue();
                if (!seen.Add(row.LogicalName + row.Id)) continue;
                if (seen.Count > 10000) throw new InvalidPluginExecutionException("Rule revision exceeds 10,000 configuration records.");
                var attrs = row.Attributes.Where(a =>
                    (a.Key.StartsWith("asx_", StringComparison.Ordinal) || a.Key == "statuscode") &&
                    a.Key != row.LogicalName + "id" && !PublicationSchema.IsProtected(a.Key) && a.Key != PublicationSchema.PublishHash)
                    .OrderBy(a => a.Key, StringComparer.Ordinal).ToDictionary(a => a.Key, a => SnapshotValue.From(a.Value));
                if (row.LogicalName == "asx_rule") attrs["statuscode"] = SnapshotValue.From(new OptionSetValue(753840000));
                result.Rows.Add(new SnapshotRow { Entity = row.LogicalName, Id = row.Id, Attributes = attrs });
                foreach (var reference in row.Attributes.Values.OfType<EntityReference>().Where(r => includeConfigs && r.LogicalName == "asx_tableconfig"))
                    if (!seen.Contains(reference.LogicalName + reference.Id)) pending.Enqueue(service.Retrieve(reference.LogicalName, reference.Id, new ColumnSet(true)));
                foreach (var edge in Edges.Where(e => e.Parent == row.LogicalName))
                {
                    var query = new QueryExpression(edge.Child) { ColumnSet = new ColumnSet(true) };
                    query.Criteria.AddCondition(edge.Lookup, ConditionOperator.Equal, row.Id);
                    foreach (var child in QueryAll(service, query)) pending.Enqueue(child);
                }
            }
            // Mapping/template references may name nodes outside the rule's selected root.
            result.Rows = result.Rows.OrderBy(r => r.Entity, StringComparer.Ordinal).ThenBy(r => r.Id).ToList();
            return result;
        }

        public sealed class Edge
        {
            public Edge(string parent, string child, string lookup) { Parent = parent; Child = child; Lookup = lookup; }
            public string Parent; public string Child; public string Lookup;
        }
        public static readonly Edge[] Edges = {
            new Edge("asx_rule", "asx_conditiongroup", "asx_rule"), new Edge("asx_rule", "asx_ruleaction", "asx_rule"),
            new Edge("asx_conditiongroup", "asx_rulecondition", "asx_conditiongroup"),
            new Edge("asx_conditiongroup", "asx_nodefiltergroup", "asx_conditiongroup"),
            new Edge("asx_rulecondition", "asx_searchcriteriagroup", "asx_rulecondition"),
            new Edge("asx_rulecondition", "asx_nodefiltergroup", "asx_rulecondition"),
            new Edge("asx_searchcriteriagroup", "asx_searchcriterion", "asx_criteriagroup"),
            new Edge("asx_searchcriteriagroup", "asx_searchcriteriagroup", "asx_parentcriteriagroup"),
            new Edge("asx_nodefiltergroup", "asx_nodefiltergroup", "asx_parentfiltergroup"),
            new Edge("asx_nodefiltergroup", "asx_nodefiltercriterion", "asx_filtergroup"),
            new Edge("asx_nodefiltercriterion", "asx_nodefiltergroup", "asx_owningcriterion"),
            new Edge("asx_ruleaction", "asx_localizedmessage", "asx_ruleaction"),
            new Edge("asx_tableconfig", "asx_tableconfig", "asx_parenttable") };

        public static List<Entity> QueryAll(IOrganizationService service, QueryExpression query)
        {
            var rows = new List<Entity>();
            query.PageInfo = new PagingInfo { Count = 5000, PageNumber = 1 };
            while (true)
            {
                var page = service.RetrieveMultiple(query); rows.AddRange(page.Entities);
                if (!page.MoreRecords) return rows;
                query.PageInfo.PageNumber++; query.PageInfo.PagingCookie = page.PagingCookie;
            }
        }
    }
}
