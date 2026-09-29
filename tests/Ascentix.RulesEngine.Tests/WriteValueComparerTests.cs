using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Execution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class WriteValueComparerTests
    {
        private static readonly Guid G = new Guid("5b0b4c6e-2f1d-4a8e-9c4b-1d2e3f405060");
        private static readonly DateTime Utc = new DateTime(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

        public static IEnumerable<object[]> EqualPairs() => new[]
        {
            new object[] { new Money(5m), 5m },
            new object[] { new OptionSetValue(2), 2 },
            new object[] { 5, 5m },
            new object[] { new OptionSetValueCollection { new OptionSetValue(1), new OptionSetValue(2) },
                           new OptionSetValueCollection { new OptionSetValue(2), new OptionSetValue(1) } },
            new object[] { new OptionSetValueCollection(), null },
            new object[] { new EntityReference("contact", G) { Name = "Ann" }, new EntityReference("contact", G) },
            new object[] { Utc, DateTime.SpecifyKind(Utc, DateTimeKind.Unspecified) },
            new object[] { Utc.ToLocalTime(), Utc },
            new object[] { null, null },
            new object[] { "", null },
            new object[] { true, true },
            new object[] { "Ann", "Ann" },
        };

        public static IEnumerable<object[]> DifferentPairs() => new[]
        {
            new object[] { "abc", "ABC" },
            new object[] { new EntityReference("contact", G), new EntityReference("account", G) },
            new object[] { new Money(5m), 6m },
            new object[] { 1, null },
            new object[] { true, false },
            new object[] { new OptionSetValueCollection { new OptionSetValue(1) }, new OptionSetValueCollection { new OptionSetValue(2) } },
        };

        [Theory]
        [MemberData(nameof(EqualPairs))]
        public void Equal_values_compare_equal_whatever_their_representation(object written, object loaded)
            => Assert.True(WriteValueComparer.AreEqual(written, loaded));

        [Theory]
        [MemberData(nameof(DifferentPairs))]
        public void Different_values_compare_different(object written, object loaded)
            => Assert.False(WriteValueComparer.AreEqual(written, loaded));
    }
}
