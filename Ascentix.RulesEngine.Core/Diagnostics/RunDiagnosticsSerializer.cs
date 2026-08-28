using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;

namespace Ascentix.RulesEngine.Core.Diagnostics
{
    /// <summary>Serializes RunDiagnostics to the asx_RunRules Diagnostics JSON. Sandbox-safe.</summary>
    public static class RunDiagnosticsSerializer
    {
        [DataContract]
        private class StageDto
        {
            [DataMember(Name = "name", Order = 1)] public string Name { get; set; }
            [DataMember(Name = "ms", Order = 2)] public long Ms { get; set; }
        }

        [DataContract]
        private class NodeDto
        {
            [DataMember(Name = "nodeId", Order = 1)] public string NodeId { get; set; }
            [DataMember(Name = "table", Order = 2)] public string Table { get; set; }
            [DataMember(Name = "retrieveCount", Order = 3)] public int RetrieveCount { get; set; }
            [DataMember(Name = "retrieveMultipleCount", Order = 4)] public int RetrieveMultipleCount { get; set; }
            [DataMember(Name = "rows", Order = 5)] public int Rows { get; set; }
        }

        [DataContract]
        private class DiagDto
        {
            [DataMember(Name = "totalMs", Order = 1)] public long TotalMs { get; set; }
            [DataMember(Name = "rulesLoaded", Order = 2)] public int RulesLoaded { get; set; }
            [DataMember(Name = "rulesEvaluated", Order = 3)] public int RulesEvaluated { get; set; }
            [DataMember(Name = "rulesFired", Order = 4)] public int RulesFired { get; set; }
            [DataMember(Name = "retrieveCount", Order = 5)] public int RetrieveCount { get; set; }
            [DataMember(Name = "retrieveMultipleCount", Order = 6)] public int RetrieveMultipleCount { get; set; }
            [DataMember(Name = "rowsFetched", Order = 7)] public int RowsFetched { get; set; }
            [DataMember(Name = "stages", Order = 8)] public List<StageDto> Stages { get; set; }
            [DataMember(Name = "nodes", Order = 9)] public List<NodeDto> Nodes { get; set; }
        }

        public static string Serialize(RunDiagnostics d)
        {
            var dto = new DiagDto
            {
                TotalMs = d.TotalMs,
                RulesLoaded = d.RulesLoaded,
                RulesEvaluated = d.RulesEvaluated,
                RulesFired = d.RulesFired,
                RetrieveCount = d.RetrieveCount,
                RetrieveMultipleCount = d.RetrieveMultipleCount,
                RowsFetched = d.RowsFetched,
                Stages = d.Stages.Select(s => new StageDto { Name = s.Name, Ms = s.Ms }).ToList(),
                Nodes = d.Nodes.Select(n => new NodeDto
                {
                    NodeId = n.NodeId.ToString(),
                    Table = n.Table,
                    RetrieveCount = n.RetrieveCount,
                    RetrieveMultipleCount = n.RetrieveMultipleCount,
                    Rows = n.Rows
                }).ToList()
            };

            var serializer = new DataContractJsonSerializer(typeof(DiagDto));
            using (var ms = new MemoryStream())
            {
                serializer.WriteObject(ms, dto);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }
    }
}
