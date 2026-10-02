using System;
using System.Linq;
using System.Text;
using Ascentix.RulesEngine.Core.Diagnostics;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RunDiagnosticsSerializerTests
    {
        [Fact]
        public void Serialize_emits_expected_keys_and_values()
        {
            var d = new RunDiagnostics { TotalMs = 42, RulesLoaded = 3, RulesEvaluated = 2, RulesFired = 1 };
            d.AddStage("ruleLoad", 5);
            d.RecordRetrieveMultiple(Guid.NewGuid(), "perf_child1", 100);

            var json = RunDiagnosticsSerializer.Serialize(d);

            Assert.Contains("\"totalMs\":42", json);
            Assert.Contains("\"rulesFired\":1", json);
            Assert.Contains("\"ruleLoad\"", json);
            Assert.Contains("\"perf_child1\"", json);
            Assert.Contains("\"retrieveMultipleCount\":1", json);
        }

        [Fact]
        public void Existing_fields_serialize_exactly_as_before()
        {
            var d = new RunDiagnostics { TotalMs = 42, RulesLoaded = 3, RulesEvaluated = 2, RulesFired = 1 };
            d.AddStage("ruleLoad", 5);
            d.RecordRetrieveMultiple(new Guid("11111111-1111-1111-1111-111111111111"), "perf_child1", 100);

            Assert.Equal(
                "{\"totalMs\":42,\"rulesLoaded\":3,\"rulesEvaluated\":2,\"rulesFired\":1,\"retrieveCount\":0," +
                "\"retrieveMultipleCount\":1,\"rowsFetched\":100,\"stages\":[{\"name\":\"ruleLoad\",\"ms\":5}]," +
                "\"nodes\":[{\"nodeId\":\"11111111-1111-1111-1111-111111111111\",\"table\":\"perf_child1\"," +
                "\"retrieveCount\":0,\"retrieveMultipleCount\":1,\"rows\":100}]}",
                RunDiagnosticsSerializer.Serialize(d));
        }

        [Fact]
        public void Every_new_counter_is_emitted_under_its_spec_name()
        {
            var d = new RunDiagnostics
            {
                WritesSent = 1, WritesUnchanged = 1, WritesMerged = 1, BulkRequests = 1, SingleRequests = 1, InPlaceWrites = 1,
                PageRecords = 1, PageChunks = 1, PageBlocked = 1, PageFailed = 1,
                SchedulesStarted = 1, SchedulesContinued = 1, SchedulesSkipped = 1,
            };
            var json = RunDiagnosticsSerializer.Serialize(d);
            foreach (var name in new[] { "writesSent", "writesUnchanged", "writesMerged", "bulkRequests", "singleRequests",
                         "inPlaceWrites", "pageRecords", "pageChunks", "pageBlocked", "pageFailed",
                         "schedulesStarted", "schedulesContinued", "schedulesSkipped" })
                Assert.Contains("\"" + name + "\":1", json);
        }

        [Fact]
        public void New_counters_are_left_out_when_zero()
        {
            var json = RunDiagnosticsSerializer.Serialize(new RunDiagnostics { WritesSent = 3 });
            Assert.Contains("\"writesSent\":3", json);
            foreach (var name in new[] { "writesUnchanged", "bulkRequests", "pageRecords", "schedulesStarted", "nodesTruncated" })
                Assert.DoesNotContain(name, json);
        }

        [Fact]
        public void A_small_run_is_traced_whole_without_nodesTruncated()
        {
            var d = new RunDiagnostics { TotalMs = 7 };
            d.RecordRetrieveMultiple(Guid.NewGuid(), "perf_child1", 10);

            var line = RunDiagnosticsSerializer.SerializeTraceLine(d);

            Assert.Equal(RunDiagnosticsSerializer.TracePrefix + RunDiagnosticsSerializer.Serialize(d), line);
            Assert.DoesNotContain("nodesTruncated", line);
        }

        [Fact]
        public void The_trace_line_keeps_the_heaviest_nodes_within_4_KB_and_says_it_cut_them()
        {
            var d = new RunDiagnostics { TotalMs = 10 };
            for (var i = 0; i < 100; i++) d.RecordRetrieveMultiple(Guid.NewGuid(), "perf_child" + (i % 3), i);

            var line = RunDiagnosticsSerializer.SerializeTraceLine(d);

            Assert.StartsWith("asx-diag {\"totalMs\":10,", line);
            Assert.EndsWith("}", line);
            Assert.True(Encoding.UTF8.GetByteCount(line) <= RunDiagnosticsSerializer.MaxTraceLineBytes);
            Assert.Contains("\"nodesTruncated\":true", line);
            Assert.Contains("\"rows\":99}", line);      // the heaviest node is kept
            Assert.DoesNotContain("\"rows\":0}", line); // the lightest is cut
        }

        [Fact]
        public void The_trace_line_still_holds_the_cap_when_even_zero_nodes_is_too_big()
        {
            var d = new RunDiagnostics { TotalMs = 10 };
            for (var i = 0; i < 500; i++) d.AddStage("stage" + i, i);

            var line = RunDiagnosticsSerializer.SerializeTraceLine(d);

            Assert.True(Encoding.UTF8.GetByteCount(line) <= RunDiagnosticsSerializer.MaxTraceLineBytes);
            Assert.Contains("\"nodesTruncated\":true", line);
        }

        [Fact]
        public void A_200_node_run_keeps_as_many_of_the_heaviest_nodes_as_fit_under_the_cap()
        {
            var d = new RunDiagnostics { TotalMs = 10, RulesLoaded = 4 };
            d.AddStage("ruleLoad", 3);
            d.AddStage("evaluate", 5);
            d.AddStage("write", 2);
            for (var i = 0; i < 200; i++) d.RecordRetrieveMultiple(Guid.NewGuid(), "perf_child" + (i % 3), i);

            var line = RunDiagnosticsSerializer.SerializeTraceLine(d);
            var kept = Occurrences(line, "\"nodeId\"");

            Assert.True(Encoding.UTF8.GetByteCount(line) <= RunDiagnosticsSerializer.MaxTraceLineBytes);
            Assert.Contains("\"nodesTruncated\":true", line);
            Assert.Equal(3, Occurrences(line, "\"name\""));        // every stage stays
            Assert.Contains("\"rows\":199}", line);                // the heaviest node is kept
            Assert.DoesNotContain("\"rows\":0}", line);            // the lightest is cut
            Assert.Equal(Encoding.UTF8.GetByteCount(line), TruncatedLineBytes(d, kept, 3));
            Assert.True(TruncatedLineBytes(d, kept + 1, 3) > RunDiagnosticsSerializer.MaxTraceLineBytes); // one more wouldn't fit
        }

        [Fact]
        public void When_heavy_nodes_and_heavy_stages_both_overflow_nodes_go_and_the_heaviest_stages_that_fit_stay()
        {
            var d = new RunDiagnostics { TotalMs = 10 };
            for (var i = 0; i < 60; i++) d.RecordRetrieveMultiple(Guid.NewGuid(), "perf_child" + (i % 3), 1000 + i);
            for (var i = 0; i < 400; i++) d.AddStage("stage" + i, i);

            var line = RunDiagnosticsSerializer.SerializeTraceLine(d);
            var kept = Occurrences(line, "\"name\"");

            Assert.True(Encoding.UTF8.GetByteCount(line) <= RunDiagnosticsSerializer.MaxTraceLineBytes);
            Assert.Contains("\"nodesTruncated\":true", line);
            Assert.Contains("\"nodes\":[]", line);                 // node detail dropped entirely
            Assert.Contains("\"stage399\"", line);                 // the heaviest stage is kept
            Assert.DoesNotContain("\"stage0\"", line);             // the lightest is cut
            Assert.InRange(kept, 1, 399);
            Assert.Equal(Encoding.UTF8.GetByteCount(line), TruncatedLineBytes(d, 0, kept));
            Assert.True(TruncatedLineBytes(d, 0, kept + 1) > RunDiagnosticsSerializer.MaxTraceLineBytes); // one more wouldn't fit
        }

        /// <summary>UTF-8 size of a trace line for <paramref name="d"/> cut to its <paramref name="nodes"/>
        /// heaviest nodes and <paramref name="stages"/> heaviest stages, marked nodesTruncated. Built
        /// independently of the cut search: a copy holding only those nodes and stages, run through
        /// Serialize, with the nodesTruncated member (the DTO's last) appended.</summary>
        private static int TruncatedLineBytes(RunDiagnostics d, int nodes, int stages)
        {
            var copy = new RunDiagnostics
            {
                TotalMs = d.TotalMs, RulesLoaded = d.RulesLoaded, RulesEvaluated = d.RulesEvaluated, RulesFired = d.RulesFired,
            };
            foreach (var s in d.Stages.OrderByDescending(s => s.Ms).Take(stages)) copy.AddStage(s.Name, s.Ms);
            foreach (var n in d.Nodes.OrderByDescending(n => n.Rows).Take(nodes))
                copy.RecordRetrieveMultiple(n.NodeId, n.Table, n.Rows);
            copy.RetrieveCount = d.RetrieveCount;
            copy.RetrieveMultipleCount = d.RetrieveMultipleCount;
            copy.RowsFetched = d.RowsFetched;

            var json = RunDiagnosticsSerializer.Serialize(copy);
            var line = RunDiagnosticsSerializer.TracePrefix + json.Substring(0, json.Length - 1) + ",\"nodesTruncated\":true}";
            return Encoding.UTF8.GetByteCount(line);
        }

        private static int Occurrences(string text, string value)
        {
            var count = 0;
            for (var at = text.IndexOf(value, StringComparison.Ordinal); at >= 0; at = text.IndexOf(value, at + value.Length, StringComparison.Ordinal))
                count++;
            return count;
        }
    }
}
