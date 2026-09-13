using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Publication;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Gather, step one: the in-effect rules for a trigger/channel, bucketed by per-rule
    /// evaluation context and published revision. Each revision retains its own configuration
    /// service so differently published definitions of one node GUID remain independent. Owns the
    /// ruleLoad / scheduleFilter stage timers, the RulesLoaded / RulesEvaluated counters and
    /// the "Loaded … rules." trace.
    /// </summary>
    public static class RuleBuckets
    {
        /// <summary>Rules sharing a configuration source and evaluation context.</summary>
        public sealed class Bucket
        {
            public Bucket(RuleEvaluationContext context, List<Entity> rules)
            {
                Context = context;
                Rules = rules;
            }

            public RuleEvaluationContext Context { get; }
            public List<Entity> Rules { get; }
            public IOrganizationService ConfigurationService { get; set; }
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
            var revisionBuckets = new List<Bucket>();
            var publishedLoaded = 0;
            var nowUtc = DateTime.UtcNow;
            List<Entity> rules;
            using (diag.Time("ruleLoad"))
            {
                var headers = PublishedRules.Headers(systemService, logicalName);
                foreach (var header in headers.Where(h => h.GetAttributeValue<EntityReference>(PublicationSchema.Pointer) != null))
                {
                    var frozen = new SnapshotService(systemService, PublishedRules.Read(systemService, header));
                    var candidates = new RuleLoader(frozen).LoadRules(logicalName, trigger, channel);
                    publishedLoaded += candidates.Count;
                    var selected = candidates.Where(r => RuleScheduleFilter.IsInEffect(r, nowUtc)).ToList();
                    if (selected.Count > 0) revisionBuckets.Add(new Bucket(RuleEvaluationContextResolver.Resolve(selected[0]), selected) { ConfigurationService = frozen });
                }
                // Existing normalized rules remain supported until explicitly revised.
                var legacyIds = new HashSet<Guid>(headers.Where(h => h.GetAttributeValue<EntityReference>(PublicationSchema.Pointer) == null).Select(h => h.Id));
                rules = legacyIds.Count == 0 ? new List<Entity>() : new RuleLoader(systemService).LoadRules(logicalName, trigger, channel).Where(r => legacyIds.Contains(r.Id)).ToList();
            }
            diag.RulesLoaded = rules.Count + publishedLoaded;

            using (diag.Time("scheduleFilter"))
                rules = rules.Where(r => RuleScheduleFilter.IsInEffect(r, nowUtc)).ToList();
            diag.RulesEvaluated = rules.Count + revisionBuckets.Sum(b => b.Rules.Count);
            trace.Trace($"Loaded {diag.RulesEvaluated} in-effect {trigger} rules.");

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
            buckets.AddRange(revisionBuckets);
            return buckets.OrderBy(b => b.Context == RuleEvaluationContext.User ? 0 : 1).ToList();
        }
    }
}
