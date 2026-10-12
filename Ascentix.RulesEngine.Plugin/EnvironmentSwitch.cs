using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// A Boolean environment variable the plug-in reads as an on/off switch. The reading is cached per
    /// worker and per organization for <see cref="Lifetime"/>, so a save normally pays no query and a
    /// reading taken for one organization never applies to another. A missing definition or active
    /// value, or a failed read, counts as off; reading never throws.
    /// </summary>
    public sealed class EnvironmentSwitch
    {
        /// <summary>How long a reading is trusted before the next caller reads it again.</summary>
        public static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(60);

        private const string DefinitionTable = "environmentvariabledefinition";
        private const string ValueTable = "environmentvariablevalue";
        private const string ValueAlias = "switchvalue";

        private readonly string _schemaName;
        private readonly string _traceName;
        private readonly Func<DateTime> _utcNow;
        private readonly object _gate = new object();
        private readonly Dictionary<Guid, Reading> _readings = new Dictionary<Guid, Reading>();

        private struct Reading
        {
            public bool On;
            public DateTime ReadOnUtc;
        }

        /// <param name="fragment">The variable's schema-name fragment (SchemaNames.EnvironmentVariables).</param>
        /// <param name="traceName">How a failed read names the switch in the trace.</param>
        public EnvironmentSwitch(string fragment, string traceName, Func<DateTime> utcNow)
        {
            _schemaName = SchemaNames.Qualify(fragment);
            _traceName = traceName;
            _utcNow = utcNow ?? throw new ArgumentNullException(nameof(utcNow));
        }

        public bool IsOn(IOrganizationService system, Guid organizationId, ITracingService trace)
        {
            var now = _utcNow();
            lock (_gate)
            {
                // A clock that went backwards forces a re-read.
                if (_readings.TryGetValue(organizationId, out var cached)
                    && now >= cached.ReadOnUtc && now - cached.ReadOnUtc < Lifetime)
                    return cached.On;
            }

            // Two threads may both refresh at expiry; each reading is equally good.
            var on = Read(system, trace);
            lock (_gate)
            {
                _readings[organizationId] = new Reading { On = on, ReadOnUtc = now };
            }
            return on;
        }

        // The definition by schema name, outer-joined to its active value row: a value overrides the
        // default, as Dataverse resolves an environment variable's current value.
        private bool Read(IOrganizationService system, ITracingService trace)
        {
            try
            {
                var query = new QueryExpression(DefinitionTable)
                {
                    ColumnSet = new ColumnSet("defaultvalue"),
                    TopCount = 1,
                };
                query.Criteria.AddCondition("schemaname", ConditionOperator.Equal, _schemaName);
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
                TraceSafely(trace, $"{_traceName} could not be read, so it counts as off: {ex.Message}");
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

        // The message goes in as an argument, never as the format string (it may carry braces).
        internal static void TraceSafely(ITracingService trace, string message)
        {
            if (trace == null) return;
            try { trace.Trace("{0}", message); }
            catch (Exception) { /* a trace must never replace the caller's outcome */ }
        }
    }

    /// <summary>
    /// asx_BulkWrites: while it's on, the engine sends two or more creates or updates of one table as
    /// CreateMultiple / UpdateMultiple. Microsoft doesn't support bulk messages in plug-in code, so it
    /// ships off: every write is a single request unless an administrator turns it on.
    /// </summary>
    public static class BulkWrites
    {
        internal static readonly EnvironmentSwitch Shared = new EnvironmentSwitch(
            SchemaNames.EnvironmentVariables.BulkWrites, "asx_BulkWrites", () => DateTime.UtcNow);

        /// <summary>The bulk support a write executor uses: the table's answer while the switch is on,
        /// none while it's off.</summary>
        public static IBulkWriteSupport Support(EnvironmentSwitch bulkSwitch, IOrganizationService system,
            Guid organizationId, ITracingService trace) =>
            bulkSwitch.IsOn(system, organizationId, trace) ? (IBulkWriteSupport)new SdkMessageFilterBulkSupport(system) : NoBulkSupport.Instance;
    }

    /// <summary>Every table answered as not supporting bulk messages: every write goes single.</summary>
    public sealed class NoBulkSupport : IBulkWriteSupport
    {
        public static readonly NoBulkSupport Instance = new NoBulkSupport();
        private NoBulkSupport() { }
        public bool Supports(string message, string table) => false;
    }
}
