using System;
using Ascentix.RulesEngine.Core.Execution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class EvaluationZoneTests
    {
        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("  ")]
        public void An_empty_setting_is_utc(string setting)
        {
            Assert.Equal(TimeZoneInfo.Utc, EvaluationZone.Resolve(setting));
        }

        [Fact]
        public void A_windows_id_resolves()
        {
            Assert.Equal("Eastern Standard Time", EvaluationZone.Resolve("Eastern Standard Time").Id);
        }

        [Fact]
        public void An_unknown_id_is_a_named_error()
        {
            Assert.False(EvaluationZone.TryResolve("Mars Standard Time", out _));
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => EvaluationZone.Resolve("Mars Standard Time"));
            Assert.Contains("Mars Standard Time", ex.Message);
        }

        [Fact]
        public void The_setting_is_read_from_the_rule()
        {
            var rule = new Entity("asx_rule", Guid.NewGuid()) { ["asx_evaluationtimezone"] = "Eastern Standard Time" };
            Assert.Equal("Eastern Standard Time", EvaluationZone.SettingOf(rule));
            Assert.Null(EvaluationZone.SettingOf(null));
        }
    }
}
