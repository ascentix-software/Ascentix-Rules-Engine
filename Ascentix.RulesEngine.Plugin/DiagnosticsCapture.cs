using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// The opt-in diagnostics table for form saves. While the asx_CaptureDiagnostics environment
    /// variable is true, a save writes one asx_rulediagnostic row per saved record carrying its full
    /// diagnostics JSON (the asx-diag trace line's content, uncapped). Timings, counts and ids only.
    ///
    /// The switch is cached per worker and per organization: it is read at most once per
    /// <see cref="SwitchLifetime"/> for each organization, so a save normally pays no query and a
    /// reading taken for one organization never applies to another. A missing definition or active
    /// value, or a failed read, counts as off. Nothing here throws into the save: a failed read or
    /// row write is caught and traced. (Dataverse may still fail the save itself, because a failed
    /// request inside a synchronous plug-in dooms its transaction; the switch is for testing.)
    /// </summary>
    public sealed class DiagnosticsCapture
    {
        /// <summary>How long a read of the switch is trusted before the next save reads it again.</summary>
        public static readonly TimeSpan SwitchLifetime = EnvironmentSwitch.Lifetime;

        /// <summary>The per-worker instance RulesEnginePlugin uses.</summary>
        internal static readonly DiagnosticsCapture Shared = new DiagnosticsCapture(() => DateTime.UtcNow);

        private readonly EnvironmentSwitch _switch;

        public DiagnosticsCapture(Func<DateTime> utcNow)
        {
            _switch = new EnvironmentSwitch(SchemaNames.EnvironmentVariables.CaptureDiagnostics, "asx-diag: the capture switch",
                utcNow ?? throw new ArgumentNullException(nameof(utcNow)));
        }

        /// <summary>When the switch is on, creates one asx_rulediagnostic row per record id through
        /// <paramref name="system"/>. Never throws.</summary>
        public void Write(IOrganizationService system, IExecutionContext context, string logicalName,
            IEnumerable<Guid> recordIds, RunDiagnostics diagnostics, ITracingService trace)
        {
            if (system == null || context == null || recordIds == null || diagnostics == null) return;
            try
            {
                if (!_switch.IsOn(system, context.OrganizationId, trace)) return;

                var json = RunDiagnosticsSerializer.Serialize(diagnostics);
                foreach (var recordId in recordIds)
                    system.Create(Row(context, logicalName, recordId, json));
            }
            catch (Exception ex)
            {
                TraceSafely(trace, "asx-diag: the diagnostics row was not written: " + ex.Message);
            }
        }

        private static Entity Row(IExecutionContext context, string logicalName, Guid recordId, string json)
        {
            string Q(string fragment) => SchemaNames.Qualify(fragment);
            return new Entity(Q(SchemaNames.RuleDiagnostic.Entity))
            {
                [Q(SchemaNames.RuleDiagnostic.Name)] = logicalName + " " + context.MessageName,
                [Q(SchemaNames.RuleDiagnostic.TableLogicalName)] = logicalName,
                [Q(SchemaNames.RuleDiagnostic.RecordId)] = recordId.ToString("D"),
                [Q(SchemaNames.RuleDiagnostic.MessageName)] = context.MessageName,
                [Q(SchemaNames.RuleDiagnostic.CorrelationId)] = context.CorrelationId.ToString("D"),
                [Q(SchemaNames.RuleDiagnostic.Diagnostics)] = json,
            };
        }

        private static void TraceSafely(ITracingService trace, string message) => EnvironmentSwitch.TraceSafely(trace, message);
    }
}
