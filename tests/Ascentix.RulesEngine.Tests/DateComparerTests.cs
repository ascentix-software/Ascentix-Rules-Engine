using System;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>Spec §4.2: each date column behavior compares in its own domain, and the rule's
    /// zone decides which day / clock time an instant is.</summary>
    public class DateComparerTests
    {
        private static readonly TimeZoneInfo Utc = TimeZoneInfo.Utc;
        private static readonly TimeZoneInfo Eastern = TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");

        private static DateTime At(int y, int mo, int d, int h = 0, int mi = 0, DateTimeKind k = DateTimeKind.Utc) =>
            new DateTime(y, mo, d, h, mi, 0, k);

        private static DateTime Plain(int y, int mo, int d, int h = 0, int mi = 0) => At(y, mo, d, h, mi, DateTimeKind.Unspecified);

        [Fact]
        public void Instant_column_reads_a_value_without_offset_in_the_zone()
        {
            var field = At(2026, 9, 1, 2);   // 2026-08-31 22:00 EDT
            Assert.True(DateComparer.Compare(field, DateColumnKind.Instant, ComparisonOperator.GreaterThanOrEqual, "2026-09-01", Utc));
            Assert.False(DateComparer.Compare(field, DateColumnKind.Instant, ComparisonOperator.GreaterThanOrEqual, "2026-09-01", Eastern));
        }

        [Fact]
        public void Instant_column_compares_instants_exactly_in_any_zone()
        {
            var field = At(2026, 9, 1, 2);
            Assert.True(DateComparer.Compare(field, DateColumnKind.Instant, ComparisonOperator.Equals, "2026-09-01T02:00:00Z", Utc));
            Assert.True(DateComparer.Compare(field, DateColumnKind.Instant, ComparisonOperator.Equals, "2026-09-01T02:00:00Z", Eastern));
        }

        [Fact]
        public void Calendar_date_column_compares_dates_only()
        {
            var field = Plain(2026, 9, 1);
            Assert.False(DateComparer.Compare(field, DateColumnKind.CalendarDate, ComparisonOperator.LessThan, "2026-09-01T02:00:00Z", Utc));
            Assert.True(DateComparer.Compare(field, DateColumnKind.CalendarDate, ComparisonOperator.GreaterThanOrEqual, "2026-09-01T23:30:00Z", Utc));
        }

        [Fact]
        public void Calendar_date_column_takes_now_in_the_zone()
        {
            var field = Plain(2026, 8, 31);
            const string now = "2026-09-01T02:00:00Z";   // 22:00 EDT on Aug 31
            Assert.True(DateComparer.Compare(field, DateColumnKind.CalendarDate, ComparisonOperator.Equals, now, Eastern));
            Assert.False(DateComparer.Compare(field, DateColumnKind.CalendarDate, ComparisonOperator.Equals, now, Utc));
        }

        [Fact]
        public void Wall_clock_column_takes_instants_in_the_zone()
        {
            var field = Plain(2026, 8, 31, 20, 30);
            const string instant = "2026-09-01T00:30:00Z";   // 20:30 EDT on Aug 31
            Assert.True(DateComparer.Compare(field, DateColumnKind.WallClock, ComparisonOperator.Equals, instant, Eastern));
            Assert.False(DateComparer.Compare(field, DateColumnKind.WallClock, ComparisonOperator.Equals, instant, Utc));
        }

        [Fact]
        public void Wall_clock_column_compares_digits_for_values_without_offset()
        {
            var field = Plain(2026, 9, 1, 0, 30);
            Assert.True(DateComparer.Compare(field, DateColumnKind.WallClock, ComparisonOperator.GreaterThan, "2026-09-01T00:00:00", Utc));
            Assert.True(DateComparer.Compare(field, DateColumnKind.WallClock, ComparisonOperator.GreaterThan, "2026-09-01T00:00:00", Eastern));
        }

        // The translator refuses a value whose conversion leaves the calendar; memory must not
        // throw on the same value either: it falls back to the scalar comparison.
        [Fact]
        public void A_conversion_that_leaves_the_calendar_is_not_compared_here()
        {
            var tokyo = TimeZoneInfo.FindSystemTimeZoneById("Tokyo Standard Time");
            var dateline = TimeZoneInfo.FindSystemTimeZoneById("Dateline Standard Time");
            // 0001-01-01 00:00 in Tokyo (UTC+9) is before DateTime.MinValue in UTC.
            Assert.Null(DateComparer.Compare(At(2026, 9, 1), DateColumnKind.Instant, ComparisonOperator.GreaterThanOrEqual, "0001-01-01T00:00:00", tokyo));
            // 9999-12-31 23:00 at UTC-12 is after DateTime.MaxValue in UTC.
            Assert.Null(DateComparer.Compare(At(2026, 9, 1), DateColumnKind.Instant, ComparisonOperator.LessThanOrEqual, "9999-12-31T23:00:00", dateline));
        }

        [Fact]
        public void Anything_else_is_not_compared_here()
        {
            var field = At(2026, 9, 1);
            Assert.Null(DateComparer.Compare(field, DateColumnKind.Instant, ComparisonOperator.Equals, "abc", Utc));
            Assert.Null(DateComparer.Compare(field, DateColumnKind.Instant, ComparisonOperator.Contains, "2026-09-01", Utc));
        }
    }
}
