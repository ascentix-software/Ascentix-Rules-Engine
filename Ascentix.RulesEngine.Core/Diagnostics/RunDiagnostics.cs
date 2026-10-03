using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace Ascentix.RulesEngine.Core.Diagnostics
{
    /// <summary>Per-run timing + query/row counters. Always populated; serialized only on request.</summary>
    public class RunDiagnostics
    {
        public long TotalMs { get; set; }
        public int RulesLoaded { get; set; }
        public int RulesEvaluated { get; set; }
        public int RulesFired { get; set; }
        public int RetrieveCount { get; set; }
        public int RetrieveMultipleCount { get; set; }
        public int RowsFetched { get; set; }

        // Shared run reads (RunFetchStore): a traversal or root read answered from what an
        // earlier bucket of the same run already fetched, and a stored fetch re-read wider
        // because a request needed columns the combined demand missed (expected 0).
        public int FetchesShared { get; set; }
        public int FetchesWidened { get; set; }

        // Write path (WriteActionExecutor → ChangeSetDispatcher).
        /// <summary>Rows sent with a service request (creates, updates, deletes); in-place writes excluded.</summary>
        public int WritesSent { get; set; }
        /// <summary>Rows dropped by the no-op skip (every mapped value already held).</summary>
        public int WritesUnchanged { get; set; }
        /// <summary>Write intents merged away into another write of the same row.</summary>
        public int WritesMerged { get; set; }
        /// <summary>CreateMultiple / UpdateMultiple requests sent.</summary>
        public int BulkRequests { get; set; }
        /// <summary>Single Create / Update / Delete requests sent.</summary>
        public int SingleRequests { get; set; }
        /// <summary>Records whose update was applied to the in-flight Target (at most one per saved record).</summary>
        public int InPlaceWrites { get; set; }

        // Run pages (RunPageProcessor): what one asx_ProcessRunPage call handled.
        public int PageRecords { get; set; }
        public int PageChunks { get; set; }
        public int PageBlocked { get; set; }
        public int PageFailed { get; set; }

        // Scheduler (DueScheduleProcessor): one asx_StartDueSchedules call.
        public int SchedulesStarted { get; set; }
        public int SchedulesContinued { get; set; }
        /// <summary>Due schedules neither started nor continued (not runnable, no rule, invalid
        /// recurrence, a failed start, or left for the next call by the call budget).</summary>
        public int SchedulesSkipped { get; set; }

        private readonly List<StageTiming> _stages = new List<StageTiming>();
        private readonly Dictionary<Guid, NodeDiagnostics> _nodes = new Dictionary<Guid, NodeDiagnostics>();

        public IReadOnlyList<StageTiming> Stages => _stages;
        public IReadOnlyList<NodeDiagnostics> Nodes => _nodes.Values.ToList();

        /// <summary>Accumulate elapsed ms under a stage name (repeated names sum).</summary>
        public void AddStage(string stage, long ms)
        {
            var existing = _stages.FirstOrDefault(s => s.Name == stage);
            if (existing != null) existing.Ms += ms;
            else _stages.Add(new StageTiming { Name = stage, Ms = ms });
        }

        /// <summary>Time a block; on dispose the elapsed ms is added to the stage.</summary>
        public IDisposable Time(string stage) => new StageTimer(this, stage);

        public void RecordRetrieve(Guid nodeId, string table, int rows)
        {
            var n = Node(nodeId, table);
            n.RetrieveCount++;
            n.Rows += rows;
            RetrieveCount++;
            RowsFetched += rows;
        }

        public void RecordRetrieveMultiple(Guid nodeId, string table, int rows)
        {
            var n = Node(nodeId, table);
            n.RetrieveMultipleCount++;
            n.Rows += rows;
            RetrieveMultipleCount++;
            RowsFetched += rows;
        }

        /// <summary>Adds another run's counters, stages (summed per name) and nodes (summed per node
        /// id) into this one: a run page absorbs each chunk's engine run. TotalMs is the caller's to set.</summary>
        public void Absorb(RunDiagnostics other)
        {
            if (other == null || ReferenceEquals(other, this)) return;
            RulesLoaded += other.RulesLoaded;
            RulesEvaluated += other.RulesEvaluated;
            RulesFired += other.RulesFired;
            RetrieveCount += other.RetrieveCount;
            RetrieveMultipleCount += other.RetrieveMultipleCount;
            RowsFetched += other.RowsFetched;
            FetchesShared += other.FetchesShared;
            FetchesWidened += other.FetchesWidened;
            WritesSent += other.WritesSent;
            WritesUnchanged += other.WritesUnchanged;
            WritesMerged += other.WritesMerged;
            BulkRequests += other.BulkRequests;
            SingleRequests += other.SingleRequests;
            InPlaceWrites += other.InPlaceWrites;
            PageRecords += other.PageRecords;
            PageChunks += other.PageChunks;
            PageBlocked += other.PageBlocked;
            PageFailed += other.PageFailed;
            SchedulesStarted += other.SchedulesStarted;
            SchedulesContinued += other.SchedulesContinued;
            SchedulesSkipped += other.SchedulesSkipped;
            foreach (var s in other._stages) AddStage(s.Name, s.Ms);
            foreach (var n in other._nodes.Values)
            {
                var mine = Node(n.NodeId, n.Table);
                mine.RetrieveCount += n.RetrieveCount;
                mine.RetrieveMultipleCount += n.RetrieveMultipleCount;
                mine.Rows += n.Rows;
            }
        }

        private NodeDiagnostics Node(Guid id, string table)
        {
            if (!_nodes.TryGetValue(id, out var n))
            {
                n = new NodeDiagnostics { NodeId = id, Table = table };
                _nodes[id] = n;
            }
            return n;
        }

        private sealed class StageTimer : IDisposable
        {
            private readonly RunDiagnostics _owner;
            private readonly string _stage;
            private readonly Stopwatch _sw;
            public StageTimer(RunDiagnostics owner, string stage)
            {
                _owner = owner; _stage = stage; _sw = Stopwatch.StartNew();
            }
            public void Dispose()
            {
                _sw.Stop();
                _owner.AddStage(_stage, _sw.ElapsedMilliseconds);
            }
        }
    }

    public class StageTiming
    {
        public string Name { get; internal set; }
        public long Ms { get; internal set; }
    }

    public class NodeDiagnostics
    {
        public Guid NodeId { get; internal set; }
        public string Table { get; internal set; }
        public int RetrieveCount { get; internal set; }
        public int RetrieveMultipleCount { get; internal set; }
        public int Rows { get; internal set; }
    }
}
