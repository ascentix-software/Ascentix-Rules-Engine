using System;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ChannelModelTests
    {
        [Fact]
        public void RuleChannel_values_match_choice_contract()
        {
            Assert.Equal(1, (int)RuleChannel.Standard);
            Assert.Equal(2, (int)RuleChannel.Portal);
        }

        [Fact]
        public void RuleChannel_has_exactly_two_members()
        {
            // Value 3 ("Application") is retired; re-adding a member must fail loudly.
            var members = Enum.GetValues(typeof(RuleChannel));
            Assert.Equal(2, members.Length);
        }

        [Fact]
        public void SchemaNames_qualify_channel_choice_and_column()
        {
            Assert.Equal("asx_channel", SchemaNames.Qualify(SchemaNames.OptionSets.Channel));
            Assert.Equal("asx_channels", SchemaNames.Qualify(SchemaNames.Rule.Channels));
        }
    }
}
