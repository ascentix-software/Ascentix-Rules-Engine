using System;
using System.Collections.Generic;
using System.Diagnostics;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Shared rules-engine orchestrator: a composition of three stages. GATHER
    /// (<see cref="RuleBuckets"/> + <see cref="EvaluationGatherer"/>) reads Dataverse (rules,
    /// bucketed by evaluation context, then per bucket the config tree and plan, then, through
    /// one RunFetchStore per run, the roots and every row each record needs (each distinct read
    /// once)) into one <see cref="EvaluationInput"/> per bucket. EVALUATE
    /// (<see cref="BucketEvaluator"/>) decides what fires from that input alone. DISPATCH
    /// (<see cref="RunOutcomeAssembler"/>) returns every fired action per record. Config and
    /// metadata reads always use systemService; a bucket's traversal service follows its
    /// context. Both the plugin (enforcing adapter) and the asx_RunRules Custom API (reporting
    /// adapter) call this. Never throws on a rule outcome; a planning fault surfaces raw.
    /// </summary>
    public class RulesEngineRunner
    {
        public RuleEvaluationOutcome Run(
            IOrganizationService systemService,
            IOrganizationService userService,
            string logicalName,
            IList<RootInput> inputs,
            RuleTrigger trigger,
            RuleChannel channel,
            int languageId,
            RootBuildMode buildMode,
            ITracingService trace,
            RuleSelection selection = null)
            => Run(systemService, userService, logicalName, inputs, trigger, channel, languageId, buildMode, trace,
                DateTime.UtcNow, selection);

        /// <summary>Evaluates every bucket at <paramref name="utcNow"/>, so all rules in one run
        /// agree on "now" (date expressions, pushed date literals).</summary>
        internal RuleEvaluationOutcome Run(
            IOrganizationService systemService,
            IOrganizationService userService,
            string logicalName,
            IList<RootInput> inputs,
            RuleTrigger trigger,
            RuleChannel channel,
            int languageId,
            RootBuildMode buildMode,
            ITracingService trace,
            DateTime utcNow,
            RuleSelection selection = null)
        {
            var diag = new RunDiagnostics();
            var overall = Stopwatch.StartNew();

            var fired = new List<FiredActionResult>[inputs.Count];
            var gated = new List<Guid>[inputs.Count];
            for (var i = 0; i < inputs.Count; i++)
            {
                fired[i] = new List<FiredActionResult>();
                gated[i] = new List<Guid>();
            }

            // Table metadata (column types, option labels, date behaviors) is the same for every
            // bucket, and RuleBuckets makes one bucket per published revision: one provider per run
            // keeps it at one RetrieveEntity per table, however many rules compare dates. It reads
            // through systemService (a revision's configuration service passes metadata requests
            // straight through to it).
            var metadata = new AttributeMetadataProvider(systemService);

            // Every bucket is planned before any business data is read, so the run's store knows
            // every bucket's columns and serves each distinct read once (RunFetchStore).
            var store = new RunFetchStore(diag);
            var prepared = new List<PreparedBucket>();
            foreach (var bucket in RuleBuckets.Load(systemService, logicalName, trigger, channel, diag, trace, selection))
            {
                var traversalService = bucket.Context == RuleEvaluationContext.User ? userService : systemService;
                prepared.Add(EvaluationGatherer.Prepare(
                    bucket.ConfigurationService ?? systemService, traversalService, logicalName, buildMode,
                    bucket.Rules, bucket.Context, utcNow, diag, metadata));
            }
            foreach (var bucket in prepared)
                EvaluationGatherer.Demand(bucket, store, buildMode);

            foreach (var bucket in prepared)
            {
                var input = EvaluationGatherer.Gather(bucket, logicalName, inputs, buildMode, trigger, languageId, store, utcNow, diag);
                var verdict = BucketEvaluator.Evaluate(input, trace, diag);
                for (var k = 0; k < input.Records.Count; k++)
                {
                    fired[input.Records[k].Index].AddRange(verdict.FiredByRecord[k]);
                    gated[input.Records[k].Index].AddRange(verdict.GatedByRecord[k]);
                }
            }

            overall.Stop();
            return RunOutcomeAssembler.Assemble(inputs, fired, gated, diag, overall.ElapsedMilliseconds, trace);
        }
    }
}
