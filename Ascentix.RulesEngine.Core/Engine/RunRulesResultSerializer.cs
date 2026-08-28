using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Serializes a RuleEvaluationOutcome to the asx_RunRules Results JSON array: one element per
    /// fired action across all evaluated records. Enums are written as their string names; fields
    /// irrelevant to an action type are null. Uses DataContractJsonSerializer (sandbox-safe).
    /// </summary>
    public static class RunRulesResultSerializer
    {
        [DataContract]
        private class FiredActionDto
        {
            [DataMember(Name = "ruleId", Order = 1)] public string RuleId { get; set; }
            [DataMember(Name = "actionType", Order = 2)] public string ActionType { get; set; }
            [DataMember(Name = "fireOn", Order = 3)] public string FireOn { get; set; }
            [DataMember(Name = "targetColumn", Order = 4)] public string TargetColumn { get; set; }
            [DataMember(Name = "value", Order = 5)] public bool? Value { get; set; }
            [DataMember(Name = "message", Order = 6)] public string Message { get; set; }
            [DataMember(Name = "severity", Order = 7)] public string Severity { get; set; }
            [DataMember(Name = "targetTable", Order = 8)] public string TargetTable { get; set; }
            [DataMember(Name = "write", Order = 9, EmitDefaultValue = false)] public WriteIntentDto Write { get; set; }
        }

        [DataContract]
        [KnownType(typeof(string))]
        [KnownType(typeof(int))]
        [KnownType(typeof(long))]
        [KnownType(typeof(decimal))]
        [KnownType(typeof(double))]
        [KnownType(typeof(bool))]
        [KnownType(typeof(int[]))]
        [KnownType(typeof(object[]))]
        [KnownType(typeof(Dictionary<string, object>))]
        private class WriteIntentDto
        {
            [DataMember(Name = "operation", Order = 1)] public string Operation { get; set; }
            [DataMember(Name = "targetTable", Order = 2)] public string TargetTable { get; set; }
            [DataMember(Name = "targetId", Order = 3)] public string TargetId { get; set; }
            [DataMember(Name = "values", Order = 4, EmitDefaultValue = false)] public Dictionary<string, object> Values { get; set; }
        }

        private static WriteIntentDto ToWriteDto(WriteIntent w)
        {
            if (w == null) return null;
            var values = new Dictionary<string, object>();
            if (w.Values != null)
                foreach (var kv in w.Values) values[kv.Key] = EncodeValue(kv.Value);
            return new WriteIntentDto
            {
                Operation = w.Operation.ToString(),
                TargetTable = w.TargetTable,
                TargetId = w.TargetId?.ToString(),
                Values = w.Operation == WriteOperation.Delete ? null : values
            };
        }

        // CLR attribute value → RecordJson-encoded primitive for reporting.
        private static object EncodeValue(object v)
        {
            switch (v)
            {
                case null: return null;
                case OptionSetValue os: return os.Value;
                case Money m: return m.Value;
                case EntityReference er:
                    return new Dictionary<string, object> { ["id"] = er.Id.ToString(), ["logicalname"] = er.LogicalName };
                case OptionSetValueCollection col:
                    return col.Select(o => o.Value).ToArray();
                case DateTime dt: return dt.ToString("o");
                default: return v; // string/bool/int/decimal pass through
            }
        }

        public static string Serialize(RuleEvaluationOutcome outcome)
        {
            var dtos = outcome.Records
                .SelectMany(r => r.FiredActions)
                .Select(a => new FiredActionDto
                {
                    RuleId = a.RuleId.ToString(),
                    ActionType = a.ActionType.ToString(),
                    FireOn = a.FireOn.ToString(),
                    TargetColumn = a.TargetColumn,
                    Value = a.Value,
                    Message = a.Message,
                    Severity = a.Severity?.ToString(),
                    TargetTable = a.TargetTable,
                    Write = ToWriteDto(a.WriteIntent)
                })
                .ToList();

            var settings = new DataContractJsonSerializerSettings
            {
                UseSimpleDictionaryFormat = true,
                KnownTypes = new[]
                {
                    typeof(string),
                    typeof(int),
                    typeof(long),
                    typeof(decimal),
                    typeof(double),
                    typeof(bool),
                    typeof(int[]),
                    typeof(object[]),
                    typeof(Dictionary<string, object>)
                }
            };
            var serializer = new DataContractJsonSerializer(typeof(List<FiredActionDto>), settings);
            using (var ms = new MemoryStream())
            {
                serializer.WriteObject(ms, dtos);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }
    }
}
