using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
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
        public static readonly TimeSpan SwitchLifetime = TimeSpan.FromSeconds(60);

        /// <summary>The per-worker instance RulesEnginePlugin uses.</summary>
        internal static readonly DiagnosticsCapture Shared = new DiagnosticsCapture(() => DateTime.UtcNow);

        private const string DefinitionTable = "environmentvariabledefinition";
        private const string ValueTable = "environmentvariablevalue";
        private const string ValueAlias = "switchvalue";

        private readonly Func<DateTime> _utcNow;
        private readonly object _gate = new object();
        // The cache, per organization id: the last switch reading and when it was taken.
        private readonly Dictionary<Guid, Reading> _readings = new Dictionary<Guid, Reading>();

        private struct Reading
        {
            public bool On;
            public DateTime ReadOnUtc;
        }

        public DiagnosticsCapture(Func<DateTime> utcNow)
        {
            _utcNow = utcNow ?? throw new ArgumentNullException(nameof(utcNow));
        }

        /// <summary>When the switch is on, creates one asx_rulediagnostic row per record id through
        /// <paramref name="system"/>. Never throws.</summary>
        public void Write(IOrganizationService system, IExecutionContext context, string logicalName,
            IEnumerable<Guid> recordIds, RunDiagnostics diagnostics, ITracingService trace)
        {
            if (system == null || context == null || recordIds == null || diagnostics == null) return;
            try
            {
                if (!IsOn(system, context.OrganizationId, trace)) return;

                var json = RunDiagnosticsSerializer.Serialize(diagnostics);
                foreach (var recordId in recordIds)
                    system.Create(Row(context, logicalName, recordId, json));
            }
            catch (Exception ex)
            {
                TraceSafely(trace, "asx-diag: the diagnostics row was not written: " + ex.Message);
            }
        }

        private bool IsOn(IOrganizationService system, Guid organizationId, ITracingService trace)
        {
            var now = _utcNow();
            lock (_gate)
            {
                // A clock that went backwards forces a re-read.
                if (_readings.TryGetValue(organizationId, out var cached)
                    && now >= cached.ReadOnUtc && now - cached.ReadOnUtc < SwitchLifetime)
                    return cached.On;
            }

            // Two threads may both refresh at expiry; each reading is equally good.
            var on = ReadSwitch(system, trace);
            lock (_gate)
            {
                _readings[organizationId] = new Reading { On = on, ReadOnUtc = now };
            }
            return on;
        }

        // The definition by schema name, outer-joined to its active value row: a value overrides the
        // default, as Dataverse resolves an environment variable's current value.
        private static bool ReadSwitch(IOrganizationService system, ITracingService trace)
        {
            try
            {
                var query = new QueryExpression(DefinitionTable)
                {
                    ColumnSet = new ColumnSet("defaultvalue"),
                    TopCount = 1,
                };
                query.Criteria.AddCondition("schemaname", ConditionOperator.Equal,
                    SchemaNames.Qualify(SchemaNames.EnvironmentVariables.CaptureDiagnostics));
                var value = query.AddLink(ValueTable, "environmentvariabledefinitionid",
                    "environmentvariabledefinitionid", JoinOperator.LeftOuter);
                value.EntityAlias = ValueAlias;
                value.Columns = new ColumnSet("value");
                value.LinkCriteria.AddCondition("statecode", ConditionOperator.Equal, 0);

                var definition = system.RetrieveMultiple(query).Entities.FirstOrDefault();
                if (definition == null) return false;

                var set = definition.GetAttributeValue<AliasedValue>(ValueAlias + ".value")?.Value as string;
                return IsTrue(string.IsNullOrWhiteSpace(set) ? definition.GetAttributeValue<string>("defaultvalue") : set);
            }
            catch (Exception ex)
            {
                TraceSafely(trace, "asx-diag: the capture switch could not be read, so it counts as off: " + ex.Message);
                return false;
            }
        }

        // Dataverse stores a Boolean environment variable as "yes"/"no"; "true"/"false" and "1"/"0"
        // are accepted too, case-insensitively. Anything else is off.
        private static bool IsTrue(string text)
        {
            var value = text?.Trim();
            return string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
                || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase)
                || value == "1";
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

        // The message goes in as an argument, never as the format string (it may carry braces).
        private static void TraceSafely(ITracingService trace, string message)
        {
            if (trace == null) return;
            try
            {
                trace.Trace("{0}", message);
            }
            catch (Exception)
            {
                // Deliberately ignored: a diagnostics trace must never replace the save's outcome.
            }
        }
    }
}
