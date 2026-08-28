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
