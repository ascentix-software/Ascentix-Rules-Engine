using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// The rules one runner call loaded (RuleBuckets.Load), kept for later calls that evaluate the
    /// same selection: a Rule Run page evaluates its rule in groups of records, and a published
    /// revision can't change inside the page's transaction, so loading it once per page is enough.
    /// The first Run given an empty cache loads and fills it; later Runs reuse it and report the same
    /// rulesLoaded / rulesEvaluated counters. Callers keep one cache per rule selection.
    /// </summary>
    public sealed class LoadedRulesCache
    {
        internal IReadOnlyList<RuleBuckets.Bucket> Buckets { get; set; }
        internal int RulesLoaded { get; set; }
        internal int RulesEvaluated { get; set; }
    }
}
