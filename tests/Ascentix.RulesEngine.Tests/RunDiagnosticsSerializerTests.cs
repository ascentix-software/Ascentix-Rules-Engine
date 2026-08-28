using System;
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
    }
}
