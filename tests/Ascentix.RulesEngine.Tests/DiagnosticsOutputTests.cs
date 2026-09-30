using System;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Plugin;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class DiagnosticsOutputTests
    {
        private sealed class ThrowingTrace : ITracingService
        {
            public void Trace(string format, params object[] args) => throw new FormatException("Input string was not in a correct format.");
        }

        private sealed class RecordingTrace : ITracingService
        {
            public string Last;
            public void Trace(string format, params object[] args) => Last = args.Length == 0 ? format : string.Format(format, args);
        }

        private static XrmFakedPluginExecutionContext Context(ParameterCollection input) =>
            new XrmFakedPluginExecutionContext { InputParameters = input, OutputParameters = new ParameterCollection() };

        [Fact]
        public void A_failing_tracer_never_changes_the_outcome()
        {
            var d = new RunDiagnostics { TotalMs = 1, WritesSent = 3 };
            var before = RunDiagnosticsSerializer.Serialize(d);

            Assert.Null(Record.Exception(() => DiagnosticsOutput.Trace(new ThrowingTrace(), d)));

            Assert.Equal(before, RunDiagnosticsSerializer.Serialize(d));
        }

        [Fact]
        public void The_trace_is_one_asx_diag_line()
        {
            var trace = new RecordingTrace();
            var d = new RunDiagnostics { TotalMs = 5, WritesSent = 2 };
            DiagnosticsOutput.Trace(trace, d);
            Assert.Equal(RunDiagnosticsSerializer.SerializeTraceLine(d), trace.Last);
        }

        [Fact]
        public void Diagnostics_are_set_only_when_asked()
        {
            var d = new RunDiagnostics { TotalMs = 5 };

            var asked = Context(new ParameterCollection { { "IncludeDiagnostics", true } });
            DiagnosticsOutput.SetIfRequested(asked, "IncludeDiagnostics", "Diagnostics", d);
            Assert.Equal(RunDiagnosticsSerializer.Serialize(d), (string)asked.OutputParameters["Diagnostics"]);

            var off = Context(new ParameterCollection { { "IncludeDiagnostics", false } });
            DiagnosticsOutput.SetIfRequested(off, "IncludeDiagnostics", "Diagnostics", d);
            Assert.False(off.OutputParameters.ContainsKey("Diagnostics"));

            var absent = Context(new ParameterCollection());
            DiagnosticsOutput.SetIfRequested(absent, "IncludeDiagnostics", "Diagnostics", d);
            Assert.False(absent.OutputParameters.ContainsKey("Diagnostics"));
        }
    }
}
