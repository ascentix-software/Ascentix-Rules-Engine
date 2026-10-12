using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class TriggerNamesTests
    {
        [Theory]
        [InlineData("OnDemand")]
        [InlineData("ondemand")]
        [InlineData("Manual")]
        [InlineData(" manual ")]
        public void On_demand_and_its_old_name_both_parse_to_3(string raw) =>
            Assert.Equal(RuleTrigger.OnDemand, TriggerNames.Parse(raw, "asx_RunRules", RuleTrigger.OnForm));

        [Fact]
        public void Blank_uses_the_fallback() =>
            Assert.Equal(RuleTrigger.OnForm, TriggerNames.Parse("  ", "asx_ReadRules", RuleTrigger.OnForm));

        [Fact]
        public void Unknown_names_the_api_and_the_accepted_values()
        {
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => TriggerNames.Parse("Sometimes", "asx_RunRules", RuleTrigger.OnDemand));
            Assert.Contains("asx_RunRules", ex.Message);
            Assert.Contains("OnDemand", ex.Message);
        }
    }
}
