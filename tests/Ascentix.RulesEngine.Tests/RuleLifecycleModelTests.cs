using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleLifecycleModelTests
    {
        [Fact]
        public void RuleStatus_values()
        {
            Assert.Equal(1, (int)RuleStatus.Draft);
            Assert.Equal(753840000, (int)RuleStatus.Published);
            Assert.Equal(2, (int)RuleStatus.Archived);
        }

        [Fact]
        public void SchemaNames_qualify_effective_dates()
        {
            Assert.Equal("asx_effectivefrom", SchemaNames.Qualify(SchemaNames.Rule.EffectiveFrom));
            Assert.Equal("asx_effectiveto", SchemaNames.Qualify(SchemaNames.Rule.EffectiveTo));
        }
    }
}
