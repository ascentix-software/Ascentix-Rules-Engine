using System;
using System.Globalization;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>
    /// Formats a date comparand for FetchXML so the server keeps every row the in-memory
    /// comparison keeps. Two forms:
    /// <list type="bullet">
    /// <item>Column behavior known (<see cref="Value"/>, <see cref="Fragment"/>): exact, reading
    /// the comparand the way DateComparer does in the rule's zone. User Local pushes the UTC
    /// instant with Z (the server reads Z the same for every caller); Time Zone Independent pushes
    /// wall-clock digits (the server compares digits); Date Only pushes a half-open range on day
    /// boundaries (<see cref="DayRange"/>).</item>
    /// <item>Behavior unknown (<see cref="Widened"/>): the comparand's digits as a UTC literal,
    /// widened one day in the relaxing direction, ranges only. Whatever the behavior and the
    /// zone, a day covers the gap between what memory and the server read.</item>
    /// </list>
    /// </summary>
    internal static class PushedDateLiteral
    {
        internal const string Format = "yyyy-MM-ddTHH:mm:ss'Z'";
        private const string DayFormat = "yyyy-MM-dd";

        /// <summary>The widened UTC literal for a range operator: one day earlier for gt/ge, one
        /// day later for lt/le. Null for any other operator, or when widening leaves the calendar.</summary>
        internal static string Widened(DateTime value, string op)
        {
            DateTime widened;
            try
            {
                switch (op)
                {
                    case "gt": case "ge": widened = value.AddDays(-1); break;
                    case "lt": case "le": widened = value.AddDays(1); break;
                    default: return null;
                }
            }
            catch (ArgumentOutOfRangeException) { return null; }
            return widened.ToString(Format, CultureInfo.InvariantCulture);
        }

        /// <summary>The value to push for <paramref name="op"/>. With a known column behavior it is
        /// exact (spec §4.3) and reads the comparand the way DateComparer does: User Local → UTC
        /// instant with Z, Date Only → the calendar day yyyy-MM-dd in the zone (pushed through
        /// <see cref="DayRange"/>, never as a bare value), Time Zone Independent → wall-clock
        /// digits in the zone. Unknown behavior → the widened UTC literal (ranges only). Null when
        /// the value cannot push (including a conversion that leaves the calendar).</summary>
        internal static string Value(DateTime value, bool isInstant, string op, DateColumnKind? kind, TimeZoneInfo zone)
        {
            if (!kind.HasValue) return Widened(value, op);
            zone = zone ?? TimeZoneInfo.Utc;
            var plain = DateTime.SpecifyKind(value, DateTimeKind.Unspecified);
            try
            {
                switch (kind.Value)
                {
                    case DateColumnKind.CalendarDate:
                        return (isInstant ? DateComparer.ToZone(value, zone) : plain).Date
                            .ToString(DayFormat, CultureInfo.InvariantCulture);
                    case DateColumnKind.WallClock:
                        return Seconds(isInstant ? DateComparer.ToZone(value, zone) : plain, op, "yyyy-MM-ddTHH:mm:ss");
                    default:
                        return Seconds(isInstant ? value : DateComparer.FromZone(plain, zone), op, Format);
                }
            }
            catch (ArgumentOutOfRangeException) { return null; }
        }

        /// <summary>The comparison fragment (no null arm) for a date comparand: a single condition,
        /// or for a Date Only column the day range. Null when it cannot push.</summary>
        internal static PushedFilter Fragment(string field, string op, DateTime value, bool isInstant, DateColumnKind? kind, TimeZoneInfo zone) =>
            Fragment(field, op, Value(value, isInstant, op, kind, zone), kind);

        /// <summary>The comparison fragment for an already formatted value (<see cref="Value"/>).</summary>
        internal static PushedFilter Fragment(string field, string op, string value, DateColumnKind? kind)
        {
            if (value == null) return null;
            if (kind == DateColumnKind.CalendarDate)
                return DateTime.TryParseExact(value, DayFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
                    ? DayRange(field, op, day)
                    : null;
            return Condition(field, op, value);
        }

        /// <summary>
        /// A Date Only comparison against day <c>D</c> as half-open ranges on day boundaries.
        /// Memory compares the stored value's date; a stored value can carry a time part (a column
        /// whose behavior changed without ConvertDateAndTimeBehavior), which the server may
        /// compare against the literal's midnight. These shapes mean the same thing either way:
        /// eq D → ge D and lt D+1; ne D → lt D or ge D+1 (the caller adds the null arm); le D →
        /// lt D+1; lt D → lt D; gt D → ge D+1; ge D → ge D. Null for any other operator, or when
        /// D+1 is needed and leaves the calendar.
        /// </summary>
        internal static PushedFilter DayRange(string field, string op, DateTime day)
        {
            var d = day.Date.ToString(DayFormat, CultureInfo.InvariantCulture);
            string Next()
            {
                try { return day.Date.AddDays(1).ToString(DayFormat, CultureInfo.InvariantCulture); }
                catch (ArgumentOutOfRangeException) { return null; }
            }
            string next;
            switch (op)
            {
                case "ge": return Condition(field, "ge", d);
                case "lt": return Condition(field, "lt", d);
                case "gt": return (next = Next()) == null ? null : Condition(field, "ge", next);
                case "le": return (next = Next()) == null ? null : Condition(field, "lt", next);
                case "eq":
                case "ne":
                    if ((next = Next()) == null) return null;
                    var eq = op == "eq";
                    var f = new PushedFilter { Op = eq ? LogicalOperator.And : LogicalOperator.Or };
                    f.Conditions.Add(new PushedCondition { Attribute = field, Operator = eq ? "ge" : "lt", Value = d });
                    f.Conditions.Add(new PushedCondition { Attribute = field, Operator = eq ? "lt" : "ge", Value = next });
                    return f;
                default: return null;
            }
        }

        private static PushedFilter Condition(string field, string op, string value)
        {
            var f = new PushedFilter();
            f.Conditions.Add(new PushedCondition { Attribute = field, Operator = op, Value = value });
            return f;
        }

        // Dataverse stores whole seconds. A comparand with a fraction (only "now" has one) rounds
        // toward the side that keeps every row memory keeps: down for gt/ge/eq, up for lt/le. `ne`
        // with a fraction cannot push: memory keeps every row, the server would drop one.
        private static string Seconds(DateTime value, string op, string format)
        {
            var whole = new DateTime(value.Ticks - value.Ticks % TimeSpan.TicksPerSecond, value.Kind);
            if (whole != value)
            {
                if (op == "ne") return null;
                if (op == "lt" || op == "le") whole = whole.AddSeconds(1);
            }
            return whole.ToString(format, CultureInfo.InvariantCulture);
        }

        /// <summary>Reads an authored literal as a date: a value with a zone (Z or an offset after
        /// the time) converts to UTC and is an instant; a value without one keeps its digits as UTC
        /// and is not. False when the literal is not a date.</summary>
        internal static bool TryParse(string literal, out DateTime value, out bool isInstant)
        {
            isInstant = false;
            if (string.IsNullOrWhiteSpace(literal) ||
                !DateTime.TryParse(literal, CultureInfo.InvariantCulture,
                    DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out value))
            {
                value = default;
                return false;
            }
            // The parser itself says whether it read a zone: RoundtripKind leaves a zone-less value
            // Unspecified. (A text test for a trailing offset misreads "09-01-2026" as "-2026".)
            isInstant = DateTime.TryParse(literal, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var raw)
                && raw.Kind != DateTimeKind.Unspecified;
            return true;
        }
    }
}
