using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class OriginResolverTests
    {
        [Fact]
        public void Portal_call_resolves_Portal()
            => Assert.Equal(RuleChannel.Portal, OriginResolver.Resolve(true));

        [Fact]
        public void Non_portal_call_resolves_Standard()
            => Assert.Equal(RuleChannel.Standard, OriginResolver.Resolve(false));
    }
}
