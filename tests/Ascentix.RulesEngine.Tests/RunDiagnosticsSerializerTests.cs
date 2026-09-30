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
    }
}
