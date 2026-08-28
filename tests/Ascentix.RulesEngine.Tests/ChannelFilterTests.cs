using System;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ChannelFilterTests
    {
        private static Entity Rule(params int[] channelValues)
        {
            var e = new Entity(SchemaNames.Qualify(SchemaNames.Rule.Entity), Guid.NewGuid());
            if (channelValues.Length > 0)
                e[SchemaNames.Qualify(SchemaNames.Rule.Channels)] =
                    new OptionSetValueCollection(channelValues.Select(v => new OptionSetValue(v)).ToList());
            return e;
        }

        [Fact]
        public void Empty_channels_applies_to_every_channel()
        {
            var rule = Rule(); // no asx_channels attribute set
            Assert.True(ChannelFilter.Applies(rule, RuleChannel.Standard));
            Assert.True(ChannelFilter.Applies(rule, RuleChannel.Portal));
        }

        [Fact]
        public void Contained_channel_applies()
            => Assert.True(ChannelFilter.Applies(
                Rule((int)RuleChannel.Standard, (int)RuleChannel.Portal), RuleChannel.Portal));

        [Fact]
        public void Excluded_channel_does_not_apply()
            => Assert.False(ChannelFilter.Applies(Rule((int)RuleChannel.Portal), RuleChannel.Standard));

        [Fact]
        public void Legacy_application_value_counts_as_Standard()
        {
            // A rule authored while asx_channel 3 ("Application") existed keeps firing on Standard
            // and is still excluded from Portal.
            var rule = Rule(ChannelFilter.LegacyApplicationValue);
            Assert.True(ChannelFilter.Applies(rule, RuleChannel.Standard));
            Assert.False(ChannelFilter.Applies(rule, RuleChannel.Portal));
        }
    }
}
