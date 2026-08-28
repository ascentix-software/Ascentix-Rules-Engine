using System.Collections.Generic;
using System.Diagnostics;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Shared rules-engine orchestrator: a composition of three stages. GATHER
    /// (<see cref="RuleBuckets"/> + <see cref="EvaluationGatherer"/>) reads Dataverse (rules,
    /// bucketed by evaluation context, then per bucket the config tree, plan, roots and every
    /// row each record needs) into one <see cref="EvaluationInput"/> per bucket. EVALUATE
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
            ITracingService trace)
        {
            var diag = new RunDiagnostics();
            var overall = Stopwatch.StartNew();

            var fired = new List<FiredActionResult>[inputs.Count];
            for (var i = 0; i < inputs.Count; i++) fired[i] = new List<FiredActionResult>();

            foreach (var bucket in RuleBuckets.Load(systemService, logicalName, trigger, channel, diag, trace))
            {
                var traversalService = bucket.Context == RuleEvaluationContext.User ? userService : systemService;
                var input = EvaluationGatherer.ForBucket(
                    systemService, traversalService, logicalName, inputs, buildMode, trigger, languageId,
                    bucket.Rules, bucket.Context, diag);
                var verdict = BucketEvaluator.Evaluate(input, trace, diag);
                for (var k = 0; k < input.Records.Count; k++)
                    fired[input.Records[k].Index].AddRange(verdict.FiredByRecord[k]);
            }

            overall.Stop();
            return RunOutcomeAssembler.Assemble(inputs, fired, diag, overall.ElapsedMilliseconds, trace);
        }
    }
}
