using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Gather, step one: the in-effect rules for a trigger/channel, bucketed by per-rule
    /// evaluation context (asx_evaluationcontext). A bucket's only effect downstream is which
    /// traversal service reads business data for it, so bucketing is a gather concern. Owns the
    /// ruleLoad / scheduleFilter stage timers, the RulesLoaded / RulesEvaluated counters and
    /// the "Loaded … rules." trace.
    /// </summary>
    public static class RuleBuckets
    {
        /// <summary>One evaluation context's rules, in loader order.</summary>
        public sealed class Bucket
        {
            public Bucket(RuleEvaluationContext context, List<Entity> rules)
            {
                Context = context;
                Rules = rules;
            }

            public RuleEvaluationContext Context { get; }
            public List<Entity> Rules { get; }
        }

        /// <summary>Ordered buckets: User first, then System; an empty bucket is omitted, so no
        /// rules means no buckets.</summary>
        public static IReadOnlyList<Bucket> Load(
            IOrganizationService systemService,
            string logicalName,
            RuleTrigger trigger,
            RuleChannel channel,
            RunDiagnostics diag,
            ITracingService trace)
        {
            List<Entity> rules;
            using (diag.Time("ruleLoad"))
                rules = new RuleLoader(systemService).LoadRules(logicalName, trigger, channel);
            diag.RulesLoaded = rules.Count;

            var nowUtc = DateTime.UtcNow;
            using (diag.Time("scheduleFilter"))
                rules = rules.Where(r => RuleScheduleFilter.IsInEffect(r, nowUtc)).ToList();
            diag.RulesEvaluated = rules.Count;
            trace.Trace($"Loaded {rules.Count} in-effect {trigger} rules.");

            var buckets = new List<Bucket>();
            if (rules.Any())
            {
                var userRules = rules
                    .Where(r => RuleEvaluationContextResolver.Resolve(r) == RuleEvaluationContext.User).ToList();
                var systemRules = rules
                    .Where(r => RuleEvaluationContextResolver.Resolve(r) == RuleEvaluationContext.System).ToList();

                if (userRules.Any())
                    buckets.Add(new Bucket(RuleEvaluationContext.User, userRules));
                if (systemRules.Any())
                    buckets.Add(new Bucket(RuleEvaluationContext.System, systemRules));
            }
            return buckets;
        }
    }
}
