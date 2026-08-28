using System;
using Ascentix.RulesEngine.Core.Execution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class DateMathTests
    {
        private static readonly DateTime Anchor = new DateTime(2026, 1, 31, 10, 30, 0, DateTimeKind.Utc);

        [Theory]
        [InlineData("minutes", 15)]
        [InlineData("hours", 3)]
        [InlineData("days", 10)]
        public void Add_small_units(string unit, int amount)
        {
            var expected = unit == "minutes" ? Anchor.AddMinutes(amount)
                : unit == "hours" ? Anchor.AddHours(amount)
                : Anchor.AddDays(amount);
            Assert.Equal(expected, DateMath.Apply(Anchor, "add", amount, unit));
        }

        [Fact]
        public void Weeks_are_seven_days()
        {
            Assert.Equal(Anchor.AddDays(14), DateMath.Apply(Anchor, "add", 2, "weeks"));
        }

        [Fact]
        public void Subtract_negates_the_amount()
        {
            Assert.Equal(Anchor.AddDays(-3), DateMath.Apply(Anchor, "subtract", 3, "days"));
        }

        [Fact]
        public void Months_clamp_at_month_end()
        {
            // Jan 31 + 1 month = Feb 28 (2026 is not a leap year), the .NET AddMonths semantics.
            Assert.Equal(new DateTime(2026, 2, 28, 10, 30, 0, DateTimeKind.Utc),
                DateMath.Apply(Anchor, "add", 1, "months"));
        }

        [Fact]
        public void Years_add_whole_years()
        {
            Assert.Equal(Anchor.AddYears(2), DateMath.Apply(Anchor, "add", 2, "years"));
        }

        [Fact]
        public void Unknown_op_and_unit_throw()
        {
            Assert.Throws<InvalidPluginExecutionException>(() => DateMath.Apply(Anchor, "times", 1, "days"));
            Assert.Throws<InvalidPluginExecutionException>(() => DateMath.Apply(Anchor, "add", 1, "fortnights"));
        }

        [Fact]
        public void Kind_is_preserved()
        {
            Assert.Equal(DateTimeKind.Utc, DateMath.Apply(Anchor, "add", 1, "days").Kind);
        }
    }
}
