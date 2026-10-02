using System.Linq;
using Ascentix.RulesEngine.Core.Diagnostics;
using System;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RunDiagnosticsTests
    {
        [Fact]
        public void AddStage_accumulates_repeated_stage_names()
        {
            var d = new RunDiagnostics();
            d.AddStage("queryExecute", 10);
            d.AddStage("queryExecute", 5);
            d.AddStage("evaluate", 3);

            Assert.Equal(15, d.Stages.Single(s => s.Name == "queryExecute").Ms);
            Assert.Equal(3, d.Stages.Single(s => s.Name == "evaluate").Ms);
        }

        [Fact]
        public void RecordRetrieve_tallies_per_node_and_totals()
        {
            var d = new RunDiagnostics();
            var node = Guid.NewGuid();
            d.RecordRetrieve(node, "perf_lookup1", 1);
            d.RecordRetrieve(node, "perf_lookup1", 1);
            d.RecordRetrieveMultiple(node, "perf_lookup1", 50);

            var nd = d.Nodes.Single(n => n.NodeId == node);
            Assert.Equal(2, nd.RetrieveCount);
            Assert.Equal(1, nd.RetrieveMultipleCount);
            Assert.Equal(52, nd.Rows);
            Assert.Equal(2, d.RetrieveCount);
            Assert.Equal(1, d.RetrieveMultipleCount);
            Assert.Equal(52, d.RowsFetched);
        }

        [Fact]
        public void Time_records_a_stage_on_dispose()
        {
            var d = new RunDiagnostics();
            using (d.Time("ruleLoad")) { }
            Assert.Contains(d.Stages, s => s.Name == "ruleLoad");
        }

        [Fact]
        public void Absorb_sums_counters_stages_and_nodes_but_not_totalMs()
        {
            var node = Guid.NewGuid();
            var page = new RunDiagnostics { TotalMs = 900, PageChunks = 1 };
            page.AddStage("pageSelect", 4);
            var chunk = new RunDiagnostics { TotalMs = 50, RulesEvaluated = 2, WritesSent = 3 };
            chunk.AddStage("queryExecute", 20);
            chunk.RecordRetrieveMultiple(node, "perf_child1", 10);

            page.Absorb(chunk);
            page.Absorb(chunk);
            page.Absorb(null);
            page.Absorb(page);

            Assert.Equal(900, page.TotalMs);
            Assert.Equal(4, page.RulesEvaluated);
            Assert.Equal(6, page.WritesSent);
            Assert.Equal(1, page.PageChunks);
            Assert.Equal(2, page.RetrieveMultipleCount);
            Assert.Equal(20, page.RowsFetched);
            Assert.Equal(40, page.Stages.Single(s => s.Name == "queryExecute").Ms);
            Assert.Equal(4, page.Stages.Single(s => s.Name == "pageSelect").Ms);
            var nd = page.Nodes.Single();
            Assert.Equal(node, nd.NodeId);
            Assert.Equal(2, nd.RetrieveMultipleCount);
            Assert.Equal(20, nd.Rows);
        }
    }
}
