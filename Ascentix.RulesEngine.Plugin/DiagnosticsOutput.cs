using System;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Where diagnostics leave the engine outside asx_RunRules: the optional IncludeDiagnostics input
    /// and Diagnostics output of asx_ApplyRules, asx_ProcessRunPage and asx_StartDueSchedules, and the
    /// one asx-diag trace line of a form save. Timings, counts and node ids only.
    /// </summary>
    public static class DiagnosticsOutput
    {
        /// <summary>True when the caller passed <paramref name="includeParameter"/> = true.</summary>
        public static bool Requested(IPluginExecutionContext context, string includeParameter) =>
            context.InputParameters.TryGetValue(includeParameter, out var value) && value is bool on && on;

        /// <summary>Sets <paramref name="outputProperty"/> to the diagnostics JSON when the caller asked
        /// for it; otherwise the output is not set at all.</summary>
        public static void SetIfRequested(IPluginExecutionContext context, string includeParameter, string outputProperty,
            RunDiagnostics diagnostics)
        {
            if (diagnostics != null && Requested(context, includeParameter))
                context.OutputParameters[outputProperty] = RunDiagnosticsSerializer.Serialize(diagnostics);
        }

        /// <summary>Writes the asx-diag line. Dataverse keeps it only when the environment's plug-in trace
        /// setting is All (or Exception, for a failed save). The line goes in as an argument, never as
        /// the format string, so its JSON braces are never parsed as placeholders. A failure to write it
        /// is swallowed: a diagnostics line must never replace the save's own outcome or error.</summary>
        public static void Trace(ITracingService trace, RunDiagnostics diagnostics)
        {
            if (trace == null || diagnostics == null) return;
            try
            {
                trace.Trace("{0}", RunDiagnosticsSerializer.SerializeTraceLine(diagnostics));
            }
            catch (Exception)
            {
                // Deliberately ignored (see summary).
            }
        }
    }
}
