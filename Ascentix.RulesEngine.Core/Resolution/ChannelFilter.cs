using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>
    /// Decides whether a rule entity applies on the current origin channel.
    /// Reads the rule's asx_channels multi-select: empty/absent ⇒ applies on
    /// all channels (back-compat); otherwise applies iff the set contains the
    /// current channel. A stored value of 3 (the retired "Application" option)
    /// counts as Standard, so a rule authored while that option existed keeps
    /// firing on the standard channel.
    /// </summary>
    public static class ChannelFilter
    {
        private static readonly string ChannelsField = SchemaNames.Qualify(SchemaNames.Rule.Channels);

        /// <summary>Option value of the retired "Application" channel (asx_channel = 3).</summary>
        public const int LegacyApplicationValue = 3;

        public static bool Applies(Entity rule, RuleChannel current)
        {
            var channels = rule.GetAttributeValue<OptionSetValueCollection>(ChannelsField);
            if (channels == null || channels.Count == 0) return true;
            return channels.Any(o => Normalize(o.Value) == (int)current);
        }

        private static int Normalize(int stored)
            => stored == LegacyApplicationValue ? (int)RuleChannel.Standard : stored;
    }
}
