using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>
    /// Resolves the origin channel of the current operation from the one
    /// IPluginExecutionContext2 signal the platform guarantees: IsPortalsClientCall.
    /// Portal when set; Standard for every other origin. Pure (no SDK context)
    /// so it is unit-testable.
    /// </summary>
    public static class OriginResolver
    {
        public static RuleChannel Resolve(bool isPortalsClientCall)
            => isPortalsClientCall ? RuleChannel.Portal : RuleChannel.Standard;
    }
}
