using System;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>The time zone a rule's date comparisons use (asx_evaluationtimezone): UTC when
    /// the setting is blank, otherwise the named Windows time zone. It decides which calendar
    /// day and which wall-clock time an instant is, for Date Only and Time Zone Independent
    /// columns (see DateComparer).</summary>
    public static class EvaluationZone
    {
        public static bool TryResolve(string setting, out TimeZoneInfo zone)
        {
            zone = TimeZoneInfo.Utc;
            if (string.IsNullOrWhiteSpace(setting)) return true;
            try
            {
                zone = TimeZoneInfo.FindSystemTimeZoneById(setting.Trim());
                return true;
            }
            catch (TimeZoneNotFoundException) { return false; }
            catch (InvalidTimeZoneException) { return false; }
        }

        /// <summary>Throws a named error for an unknown id; publish reports it first as
        /// STRUCT_INVALID_TIMEZONE.</summary>
        public static TimeZoneInfo Resolve(string setting)
        {
            if (TryResolve(setting, out var zone)) return zone;
            throw new InvalidPluginExecutionException(
                $"Rules Engine: the rule's time zone '{setting}' is not a known time zone. " +
                "Choose another in the rule's properties.");
        }

        public static string SettingOf(Entity rule) =>
            rule?.GetAttributeValue<string>(SchemaNames.Qualify(SchemaNames.Rule.EvaluationTimeZone));
    }
}
