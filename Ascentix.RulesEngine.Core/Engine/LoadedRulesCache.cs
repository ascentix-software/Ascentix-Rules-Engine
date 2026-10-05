using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// The rules one runner call loaded (RuleBuckets.Load), kept for later calls that evaluate the
    /// same selection: a Rule Run page evaluates its rule in groups of records, and the page uses one
    /// loaded rule set for consistency; a republish takes effect on the next page. Legacy rules and
    /// schedule windows are likewise fixed for the page (as loaded and filtered by the first Run).
    /// The first Run given an empty cache loads and fills it; later Runs reuse it, report the same
    /// rulesLoaded / rulesEvaluated counters and skip the "Loaded N in-effect {trigger} rules." trace line.
    /// Callers keep one cache per rule selection.
    /// </summary>
    public sealed class LoadedRulesCache
    {
        internal IReadOnlyList<RuleBuckets.Bucket> Buckets { get; set; }
        internal int RulesLoaded { get; set; }
        internal int RulesEvaluated { get; set; }
    }
}
