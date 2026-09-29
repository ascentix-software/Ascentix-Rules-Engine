using System;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Scheduling
{
    /// <summary>
    /// Pure schedule math: the next run for a <see cref="RuleScheduleDefinition"/> in a given
    /// time zone, and field-shaped validation. No Dataverse, no clock reads: every input is
    /// explicit, so this is fully unit-testable.
    /// </summary>
    public static class ScheduleCalculator
    {
        /// <summary>The next UTC instant strictly after <paramref name="fromUtc"/> that the
        /// schedule is due, evaluated in <paramref name="zone"/>.</summary>
        public static DateTime NextRun(RuleScheduleDefinition def, TimeZoneInfo zone, DateTime fromUtc)
        {
            if (!Enum.IsDefined(typeof(SchedulePattern), def.Pattern))
                throw new ArgumentException("Unknown schedule pattern.");

            fromUtc = DateTime.SpecifyKind(fromUtc, DateTimeKind.Utc);
            switch (def.Pattern)
            {
                case SchedulePattern.EveryMinutes: return fromUtc.AddMinutes(def.Every.Value);
                case SchedulePattern.EveryHours: return fromUtc.AddHours(def.Every.Value);
            }

            TryParseTimeOfDay(def.TimeOfDay, out var time);
            var localFrom = TimeZoneInfo.ConvertTimeFromUtc(fromUtc, zone);
            // Walk local calendar days from the local date of `from` (at most 62 days covers every monthly case).
            for (var day = localFrom.Date; day <= localFrom.Date.AddDays(62); day = day.AddDays(1))
            {
                if (!Matches(def, day)) continue;
                var candidate = ToUtc(day + time, zone);
                if (candidate > fromUtc) return candidate;
            }
            throw new InvalidOperationException("No next run found."); // unreachable for a valid definition
        }

        private static bool Matches(RuleScheduleDefinition def, DateTime day)
        {
            switch (def.Pattern)
            {
                case SchedulePattern.Daily: return true;
                case SchedulePattern.Weekly: return def.Days.Contains(day.DayOfWeek);
                case SchedulePattern.Monthly:
                    var target = Math.Min(def.DayOfMonth.Value, DateTime.DaysInMonth(day.Year, day.Month));
                    return day.Day == target;
                default: return false;
            }
        }

        // Local wall time → UTC. A time in the spring-forward gap moves to the first valid minute after it;
        // an ambiguous (fall-back) time takes its first occurrence, the daylight offset.
        private static DateTime ToUtc(DateTime local, TimeZoneInfo zone)
        {
            local = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
            while (zone.IsInvalidTime(local)) local = local.AddMinutes(1);
            if (zone.IsAmbiguousTime(local))
            {
                var offsets = zone.GetAmbiguousTimeOffsets(local);
                var daylight = offsets.Max(); // the larger offset is daylight time, which comes first
                return DateTime.SpecifyKind(local - daylight, DateTimeKind.Utc);
            }
            return TimeZoneInfo.ConvertTimeToUtc(local, zone);
        }

        /// <summary>Field-shaped validation. Returns the first message found, or null when valid.
        /// Order: an undefined pattern first; then pattern-specific Every; then, for
        /// Daily/Weekly/Monthly, time missing, then time format; then days (Weekly); then day of
        /// month (Monthly).</summary>
        public static string Validate(RuleScheduleDefinition def)
        {
            if (!Enum.IsDefined(typeof(SchedulePattern), def.Pattern))
                return "Choose how often the schedule runs.";

            switch (def.Pattern)
            {
                case SchedulePattern.EveryMinutes:
                    if (def.Every != 15 && def.Every != 30 && def.Every != 45)
                        return "Every N minutes must be 15, 30 or 45.";
                    return null;

                case SchedulePattern.EveryHours:
                    if (def.Every == null || def.Every < 1 || def.Every > 23)
                        return "Every N hours must be between 1 and 23.";
                    return null;

                case SchedulePattern.Daily:
                case SchedulePattern.Weekly:
                case SchedulePattern.Monthly:
                    if (string.IsNullOrWhiteSpace(def.TimeOfDay))
                        return "Choose a time of day for a daily, weekly or monthly schedule.";
                    if (!TryParseTimeOfDay(def.TimeOfDay, out _))
                        return "Time of day must be HH:mm (24-hour).";

                    if (def.Pattern == SchedulePattern.Weekly && (def.Days == null || def.Days.Count == 0))
                        return "Choose at least one day for a weekly schedule.";

                    if (def.Pattern == SchedulePattern.Monthly &&
                        (def.DayOfMonth == null || def.DayOfMonth < 1 || def.DayOfMonth > 31))
                        return "Choose a day of the month for a monthly schedule.";

                    return null;

                default:
                    return null;
            }
        }

        /// <summary>Parses exactly "HH:mm" (24-hour): HH 00-23, mm 00-59.</summary>
        public static bool TryParseTimeOfDay(string text, out TimeSpan time)
        {
            time = default;
            if (string.IsNullOrEmpty(text) || text.Length != 5 || text[2] != ':')
                return false;

            var hourText = text.Substring(0, 2);
            var minuteText = text.Substring(3, 2);
            if (!int.TryParse(hourText, out var hour) || !int.TryParse(minuteText, out var minute))
                return false;
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
                return false;

            time = new TimeSpan(hour, minute, 0);
            return true;
        }
    }
}
