using System;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Scheduling;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests.Scheduling
{
    /// <summary>
    /// Pure ScheduleCalculator: next-run computation per pattern in the rule's time zone,
    /// and Validate's field-shaped messages. All UTC inputs are explicit (DateTimeKind.Utc);
    /// no Dataverse, no FakeXrmEasy context, except for the FromEntity mapping test.
    /// </summary>
    public class ScheduleCalculatorTests
    {
        private static readonly TimeZoneInfo Eastern = TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");
        private static DateTime U(int y, int mo, int d, int h, int mi) => new DateTime(y, mo, d, h, mi, 0, DateTimeKind.Utc);
        private static RuleScheduleDefinition Def(SchedulePattern p, int? every = null, string time = null, DayOfWeek[] days = null, int? dom = null) =>
            new RuleScheduleDefinition { Pattern = p, Every = every, TimeOfDay = time, Days = days ?? new DayOfWeek[0], DayOfMonth = dom };

        [Fact] public void Every_15_minutes_adds_15_minutes() =>
            Assert.Equal(U(2026, 1, 5, 10, 15), ScheduleCalculator.NextRun(Def(SchedulePattern.EveryMinutes, 15), TimeZoneInfo.Utc, U(2026, 1, 5, 10, 0)));

        [Fact] public void Every_3_hours_adds_3_hours() =>
            Assert.Equal(U(2026, 1, 5, 13, 0), ScheduleCalculator.NextRun(Def(SchedulePattern.EveryHours, 3), TimeZoneInfo.Utc, U(2026, 1, 5, 10, 0)));

        [Fact] public void Daily_at_02_00_eastern_is_the_next_02_00_local() =>
            // 2026-01-05 10:00 UTC = 05:00 EST, so the next 02:00 EST is 2026-01-06 07:00 UTC
            Assert.Equal(U(2026, 1, 6, 7, 0), ScheduleCalculator.NextRun(Def(SchedulePattern.Daily, time: "02:00"), Eastern, U(2026, 1, 5, 10, 0)));

        [Fact] public void Daily_is_strictly_after_from() =>
            Assert.Equal(U(2026, 1, 6, 7, 0), ScheduleCalculator.NextRun(Def(SchedulePattern.Daily, time: "02:00"), Eastern, U(2026, 1, 5, 7, 0)));

        [Fact] public void Weekly_picks_the_next_chosen_day_across_the_week_boundary() =>
            // Saturday 2026-01-10 12:00 UTC; Monday/Wednesday 09:00 UTC, so Monday 2026-01-12 09:00
            Assert.Equal(U(2026, 1, 12, 9, 0), ScheduleCalculator.NextRun(
                Def(SchedulePattern.Weekly, time: "09:00", days: new[] { DayOfWeek.Monday, DayOfWeek.Wednesday }), TimeZoneInfo.Utc, U(2026, 1, 10, 12, 0)));

        [Fact] public void Monthly_day_31_uses_the_last_day_of_february() =>
            Assert.Equal(U(2026, 2, 28, 6, 0), ScheduleCalculator.NextRun(Def(SchedulePattern.Monthly, time: "06:00", dom: 31), TimeZoneInfo.Utc, U(2026, 2, 1, 0, 0)));

        [Fact] public void Monthly_day_29_in_a_leap_year() =>
            Assert.Equal(U(2028, 2, 29, 6, 0), ScheduleCalculator.NextRun(Def(SchedulePattern.Monthly, time: "06:00", dom: 29), TimeZoneInfo.Utc, U(2028, 2, 1, 0, 0)));

        [Fact] public void A_time_in_the_spring_forward_gap_runs_at_the_first_valid_time() =>
            // 2026-03-08 02:30 EST doesn't exist (clocks jump 02:00 -> 03:00 EDT); expect 03:00 EDT = 07:00 UTC
            Assert.Equal(U(2026, 3, 8, 7, 0), ScheduleCalculator.NextRun(Def(SchedulePattern.Daily, time: "02:30"), Eastern, U(2026, 3, 8, 5, 0)));

        [Fact] public void An_ambiguous_fall_back_time_uses_the_first_occurrence() =>
            // 2026-11-01 01:30 local happens twice; the first is EDT = 05:30 UTC
            Assert.Equal(U(2026, 11, 1, 5, 30), ScheduleCalculator.NextRun(Def(SchedulePattern.Daily, time: "01:30"), Eastern, U(2026, 11, 1, 4, 0)));

        [Fact] public void Catch_up_from_long_ago_returns_the_next_occurrence_after_from() =>
            Assert.Equal(U(2026, 1, 6, 7, 0), ScheduleCalculator.NextRun(Def(SchedulePattern.Daily, time: "02:00"), Eastern, U(2026, 1, 5, 10, 0)));

        [Theory]
        [InlineData(1, 10, null, null, null, "Every N minutes must be 15, 30 or 45.")]
        [InlineData(2, 24, null, null, null, "Every N hours must be between 1 and 23.")]
        [InlineData(3, null, null, null, null, "Choose a time of day for a daily, weekly or monthly schedule.")]
        [InlineData(3, null, "25:00", null, null, "Time of day must be HH:mm (24-hour).")]
        [InlineData(4, null, "09:00", "", null, "Choose at least one day for a weekly schedule.")]
        [InlineData(5, null, "09:00", null, null, "Choose a day of the month for a monthly schedule.")]
        [InlineData(0, null, null, null, null, "Choose how often the schedule runs.")]
        [InlineData(9, null, null, null, null, "Choose how often the schedule runs.")]
        public void Validation_messages(int pattern, int? every, string time, string days, int? dom, string expected) =>
            Assert.Equal(expected, ScheduleCalculator.Validate(Def((SchedulePattern)pattern, every, time,
                days == null ? null : new DayOfWeek[0], dom)));

        [Fact] public void A_valid_definition_has_no_message() =>
            Assert.Null(ScheduleCalculator.Validate(Def(SchedulePattern.EveryMinutes, 30)));

        [Fact] public void NextRun_throws_for_an_undefined_pattern() =>
            Assert.Throws<ArgumentException>(() =>
                ScheduleCalculator.NextRun(Def((SchedulePattern)0), TimeZoneInfo.Utc, U(2026, 1, 5, 10, 0)));

        [Fact]
        public void FromEntity_reads_pattern_time_and_days()
        {
            var entity = new Entity(SchemaNames.Qualify(SchemaNames.RuleSchedule.Entity), Guid.NewGuid());
            entity[SchemaNames.Qualify(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Weekly);
            entity[SchemaNames.Qualify(SchemaNames.RuleSchedule.TimeOfDay)] = "09:00";
            entity[SchemaNames.Qualify(SchemaNames.RuleSchedule.DaysOfWeek)] = new OptionSetValueCollection
            {
                new OptionSetValue(1),
                new OptionSetValue(3)
            };

            var def = RuleScheduleDefinition.FromEntity(entity);

            Assert.Equal(SchedulePattern.Weekly, def.Pattern);
            Assert.Equal("09:00", def.TimeOfDay);
            Assert.Equal(new[] { DayOfWeek.Monday, DayOfWeek.Wednesday }, def.Days);
        }
    }
}
