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
    }
}
