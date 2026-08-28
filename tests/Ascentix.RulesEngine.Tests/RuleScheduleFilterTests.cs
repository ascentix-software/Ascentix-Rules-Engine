using System;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleScheduleFilterTests
    {
        private static readonly DateTime Now = new DateTime(2026, 6, 16, 12, 0, 0, DateTimeKind.Utc);

        private static Entity Rule(DateTime? from, DateTime? to)
        {
            var e = new Entity(SchemaNames.Qualify(SchemaNames.Rule.Entity), Guid.NewGuid());
            if (from.HasValue) e[SchemaNames.Qualify(SchemaNames.Rule.EffectiveFrom)] = from.Value;
            if (to.HasValue) e[SchemaNames.Qualify(SchemaNames.Rule.EffectiveTo)] = to.Value;
            return e;
        }

        [Fact] public void Open_window_is_in_effect() => Assert.True(RuleScheduleFilter.IsInEffect(Rule(null, null), Now));
        [Fact] public void Future_from_excluded() => Assert.False(RuleScheduleFilter.IsInEffect(Rule(Now.AddDays(1), null), Now));
        [Fact] public void Past_to_excluded() => Assert.False(RuleScheduleFilter.IsInEffect(Rule(null, Now.AddDays(-1)), Now));
        [Fact] public void Inside_window_in_effect() => Assert.True(RuleScheduleFilter.IsInEffect(Rule(Now.AddDays(-1), Now.AddDays(1)), Now));
        [Fact] public void Boundaries_inclusive() => Assert.True(RuleScheduleFilter.IsInEffect(Rule(Now, Now), Now));
    }
}
