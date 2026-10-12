using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;

namespace Ascentix.RulesEngine.Core.Diagnostics
{
    /// <summary>Serializes RunDiagnostics to the Diagnostics JSON (asx_RunRules and the other diagnostics
    /// outputs) and to the asx-diag trace line. Sandbox-safe.</summary>
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

            // New in the performance baseline: written only when non-zero, so an asx_RunRules
            // response (which writes nothing) keeps exactly the shape it always had.
            [DataMember(Name = "writesSent", Order = 10, EmitDefaultValue = false)] public int WritesSent { get; set; }
            [DataMember(Name = "writesUnchanged", Order = 11, EmitDefaultValue = false)] public int WritesUnchanged { get; set; }
            [DataMember(Name = "writesMerged", Order = 12, EmitDefaultValue = false)] public int WritesMerged { get; set; }
            [DataMember(Name = "bulkRequests", Order = 13, EmitDefaultValue = false)] public int BulkRequests { get; set; }
            [DataMember(Name = "singleRequests", Order = 14, EmitDefaultValue = false)] public int SingleRequests { get; set; }
            [DataMember(Name = "inPlaceWrites", Order = 15, EmitDefaultValue = false)] public int InPlaceWrites { get; set; }
            [DataMember(Name = "pageRecords", Order = 16, EmitDefaultValue = false)] public int PageRecords { get; set; }
            [DataMember(Name = "pageChunks", Order = 17, EmitDefaultValue = false)] public int PageChunks { get; set; }
            [DataMember(Name = "pageBlocked", Order = 18, EmitDefaultValue = false)] public int PageBlocked { get; set; }
            [DataMember(Name = "pageFailed", Order = 19, EmitDefaultValue = false)] public int PageFailed { get; set; }
            [DataMember(Name = "schedulesStarted", Order = 20, EmitDefaultValue = false)] public int SchedulesStarted { get; set; }
            [DataMember(Name = "schedulesContinued", Order = 21, EmitDefaultValue = false)] public int SchedulesContinued { get; set; }
            [DataMember(Name = "schedulesSkipped", Order = 22, EmitDefaultValue = false)] public int SchedulesSkipped { get; set; }
            [DataMember(Name = "nodesTruncated", Order = 23, EmitDefaultValue = false)] public bool NodesTruncated { get; set; }
            [DataMember(Name = "fetchesShared", Order = 24, EmitDefaultValue = false)] public int FetchesShared { get; set; }
            [DataMember(Name = "fetchesWidened", Order = 25, EmitDefaultValue = false)] public int FetchesWidened { get; set; }
        }

        /// <summary>Starts the one diagnostics line a form save writes to the plug-in trace.</summary>
        public const string TracePrefix = "asx-diag ";

        /// <summary>The whole trace line stays at or under this many UTF-8 bytes, well inside the
        /// trace log's 10 KB per execution.</summary>
        public const int MaxTraceLineBytes = 4096;

        public static string Serialize(RunDiagnostics d) => Write(ToDto(d, d.Nodes, d.Stages));

        /// <summary>The asx-diag trace line: the prefix and the diagnostics JSON. When the line would
        /// pass <paramref name="maxBytes"/>, nodes are cut, heaviest (by rows) kept first, and the
        /// JSON carries "nodesTruncated": true. If even zero nodes still doesn't fit, node detail is
        /// dropped entirely and stages are cut to the largest (by ms) that fit, still marking
        /// nodesTruncated: true. Timings, counts and node ids only.</summary>
        public static string SerializeTraceLine(RunDiagnostics d, int maxBytes = MaxTraceLineBytes)
        {
            var nodes = d.Nodes;
            var line = TracePrefix + Write(ToDto(d, nodes, d.Stages));
            if (Fits(line, maxBytes)) return line;

            // All nodes don't fit, so search keep = 0 .. Count - 1.
            var heaviestNodes = nodes.OrderByDescending(n => n.Rows).ToList();
            line = LargestFittingLine(heaviestNodes.Count - 1, maxBytes,
                keep => TruncatedLine(d, heaviestNodes.Take(keep), d.Stages));
            if (line != null) return line;

            // P11: even with zero nodes kept, the line must not exceed the cap. Drop node detail
            // entirely and cut stages down to the heaviest that fit.
            var heaviestStages = d.Stages.OrderByDescending(s => s.Ms).ToList();
            Func<int, string> stageLine = keep => TruncatedLine(d, Enumerable.Empty<NodeDiagnostics>(), heaviestStages.Take(keep));
            return LargestFittingLine(heaviestStages.Count, maxBytes, stageLine) ?? stageLine(0);
        }

        /// <summary>The line for the largest keep in 0..<paramref name="maxKeep"/> that fits, or null
        /// when not even keep = 0 does. Each keep is a prefix of one fixed heaviest-first order, so the
        /// line only grows with keep and a binary search finds it in O(log n) serializations.</summary>
        private static string LargestFittingLine(int maxKeep, int maxBytes, Func<int, string> lineFor)
        {
            string best = null;
            int low = 0, high = maxKeep;
            while (low <= high)
            {
                var keep = low + (high - low) / 2;
                var line = lineFor(keep);
                if (Fits(line, maxBytes)) { best = line; low = keep + 1; }
                else high = keep - 1;
            }
            return best;
        }

        private static string TruncatedLine(RunDiagnostics d, IEnumerable<NodeDiagnostics> nodes, IEnumerable<StageTiming> stages)
        {
            var dto = ToDto(d, nodes, stages);
            dto.NodesTruncated = true;
            return TracePrefix + Write(dto);
        }

        private static bool Fits(string line, int maxBytes) => Encoding.UTF8.GetByteCount(line) <= maxBytes;

        private static DiagDto ToDto(RunDiagnostics d, IEnumerable<NodeDiagnostics> nodes, IEnumerable<StageTiming> stages) => new DiagDto
        {
            TotalMs = d.TotalMs,
            RulesLoaded = d.RulesLoaded,
            RulesEvaluated = d.RulesEvaluated,
            RulesFired = d.RulesFired,
            RetrieveCount = d.RetrieveCount,
            RetrieveMultipleCount = d.RetrieveMultipleCount,
            RowsFetched = d.RowsFetched,
            Stages = stages.Select(s => new StageDto { Name = s.Name, Ms = s.Ms }).ToList(),
            Nodes = nodes.Select(n => new NodeDto
            {
                NodeId = n.NodeId.ToString(),
                Table = n.Table,
                RetrieveCount = n.RetrieveCount,
                RetrieveMultipleCount = n.RetrieveMultipleCount,
                Rows = n.Rows
            }).ToList(),
            WritesSent = d.WritesSent,
            WritesUnchanged = d.WritesUnchanged,
            WritesMerged = d.WritesMerged,
            BulkRequests = d.BulkRequests,
            SingleRequests = d.SingleRequests,
            InPlaceWrites = d.InPlaceWrites,
            PageRecords = d.PageRecords,
            PageChunks = d.PageChunks,
            PageBlocked = d.PageBlocked,
            PageFailed = d.PageFailed,
            SchedulesStarted = d.SchedulesStarted,
            SchedulesContinued = d.SchedulesContinued,
            SchedulesSkipped = d.SchedulesSkipped,
            FetchesShared = d.FetchesShared,
            FetchesWidened = d.FetchesWidened,
        };

        // Built once: construction is the expensive part, and WriteObject is safe to share across
        // threads (no surrogate or resolver).
        private static readonly DataContractJsonSerializer DiagSerializer = new DataContractJsonSerializer(typeof(DiagDto));

        private static string Write(DiagDto dto)
        {
            using (var ms = new MemoryStream())
            {
                DiagSerializer.WriteObject(ms, dto);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }
    }
}
