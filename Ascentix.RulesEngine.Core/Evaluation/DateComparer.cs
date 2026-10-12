using System;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Evaluation
{
    /// <summary>
    /// Compares a date column's value with a comparand the way the column's behavior means it
    /// (spec §4.2). User Local compares UTC instants, Date Only compares calendar dates, Time Zone
    /// Independent compares wall-clock times. A comparand with an offset ("now", a User Local
    /// anchor, a literal ending in Z) is an instant; one without is a date or wall-clock value.
    /// Instants cross into a Date Only / Time Zone Independent column through the rule's zone;
    /// values without an offset cross into a User Local column through it.
    /// </summary>
    public static class DateComparer
    {
        /// <summary>Null when <paramref name="comparand"/> is not a date, <paramref name="op"/>
        /// is not eq/ne/gt/ge/lt/le, or converting the comparand through the zone leaves the
        /// calendar (the translator refuses the same value): the caller falls back to
        /// ValueComparer.</summary>
        public static bool? Compare(DateTime field, DateColumnKind kind, ComparisonOperator op, string comparand, TimeZoneInfo zone)
        {
            if (!PushedDateLiteral.TryParse(comparand, out var value, out var isInstant)) return null;
            zone = zone ?? TimeZoneInfo.Utc;
            var plain = DateTime.SpecifyKind(value, DateTimeKind.Unspecified);
            try
            {
                switch (kind)
                {
                    case DateColumnKind.CalendarDate:
                        return Apply(field.Date, op, (isInstant ? ToZone(value, zone) : plain).Date);
                    case DateColumnKind.WallClock:
                        return Apply(DateTime.SpecifyKind(field, DateTimeKind.Unspecified), op, isInstant ? ToZone(value, zone) : plain);
                    default:
                        return Apply(AsUtc(field), op, isInstant ? value : FromZone(plain, zone));
                }
            }
            catch (ArgumentOutOfRangeException) { return null; }
        }

        /// <summary>A date expression's anchor value, kinded by the anchor column's behavior so
        /// its round-trip ("o") string says what it is: a User Local anchor is an instant (UTC), a
        /// Date Only / Time Zone Independent anchor is a value without an offset (its stored
        /// digits). The SDK's DateTimeKind is not trusted for that; it only decides when the
        /// behavior is unknown (null), and then the value is returned unchanged. A local-kinded
        /// value (a condition anchor read back through its string) is first taken back to UTC,
        /// which recovers the digits the SDK returned. Shared by memory (ComparisonValueResolver)
        /// and the pushdown binder (DateBinding) so both read an anchor the same way.</summary>
        internal static DateTime AsAnchor(DateTime value, DateColumnKind? anchorKind)
        {
            if (!anchorKind.HasValue) return value;
            var utcDigits = value.Kind == DateTimeKind.Local ? value.ToUniversalTime() : value;
            return DateTime.SpecifyKind(utcDigits,
                anchorKind.Value == DateColumnKind.Instant ? DateTimeKind.Utc : DateTimeKind.Unspecified);
        }

        /// <summary>The wall-clock time in <paramref name="zone"/> of a UTC instant.</summary>
        internal static DateTime ToZone(DateTime utc, TimeZoneInfo zone) =>
            DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), zone), DateTimeKind.Unspecified);

        /// <summary>The UTC instant of a wall-clock time in <paramref name="zone"/>. GetUtcOffset
        /// never throws: a time a DST change skips reads with the zone's standard offset.</summary>
        internal static DateTime FromZone(DateTime wallClock, TimeZoneInfo zone)
        {
            var plain = DateTime.SpecifyKind(wallClock, DateTimeKind.Unspecified);
            return DateTime.SpecifyKind(plain - zone.GetUtcOffset(plain), DateTimeKind.Utc);
        }

        private static DateTime AsUtc(DateTime field) =>
            field.Kind == DateTimeKind.Local ? field.ToUniversalTime() : DateTime.SpecifyKind(field, DateTimeKind.Utc);

        private static bool? Apply(DateTime left, ComparisonOperator op, DateTime right)
        {
            switch (op)
            {
                case ComparisonOperator.Equals: return left == right;
                case ComparisonOperator.NotEquals: return left != right;
                case ComparisonOperator.GreaterThan: return left > right;
                case ComparisonOperator.GreaterThanOrEqual: return left >= right;
                case ComparisonOperator.LessThan: return left < right;
                case ComparisonOperator.LessThanOrEqual: return left <= right;
                default: return null;
            }
        }
    }
}
