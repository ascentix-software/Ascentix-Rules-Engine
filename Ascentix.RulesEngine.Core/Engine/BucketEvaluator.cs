using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Localization;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Evaluate: rules × records over an <see cref="EvaluationInput"/>. Pure by type: it holds
    /// no IOrganizationService; every row it reads is already in a record's cache, and metadata
    /// arrives as the two provider interfaces. Per record, per rule (loader order): execution
    /// groups gate first, then every outcome (top-level validation group) is evaluated and each
    /// action's Fires when tree decides, then
    /// <see cref="ActionDispatcher.ComputeFiredActions"/> orders what fires; a write action gets
    /// its write intents resolved (one, or one per filtered row for a set action) and a message
    /// action its template rendered. Owns the <c>evaluate</c> stage timer, which wraps exactly
    /// that: condition evaluation, write-intent resolution and rendering.
    /// </summary>
    public static class BucketEvaluator
    {
        /// <param name="diag">Optional. When present, each record's evaluation accumulates
        /// under the <c>evaluate</c> stage.</param>
        public static EvaluationVerdict Evaluate(EvaluationInput input, ITracingService trace, RunDiagnostics diag = null)
        {
            var tree = input.Tree;
            var metadata = input.Metadata;
            var templates = new TemplateRenderer(tree, input.Labels);
            var resolver = new FieldValueResolver();
            var writeResolver = new WriteIntentResolver(tree, metadata, input.Labels, input.UtcNow);

            var firedByRecord = new List<IReadOnlyList<FiredActionResult>>(input.Records.Count);
            var gatedByRecord = new List<IReadOnlyList<Guid>>(input.Records.Count);
            foreach (var record in input.Records)
            {
                var root = record.Root;
                var cache = record.Cache;
                var fired = new List<FiredActionResult>();
                var gated = new List<Guid>();

                using (diag?.Time("evaluate"))
                {
                    // On Create the root is the record being inserted: its createdon/modifiedon
                    // read the evaluation instant (see NewRecordStamp).
                    var stamp = input.Trigger == RuleTrigger.OnCreate ? new NewRecordStamp(root, input.UtcNow) : null;
                    var conditionEval = new ConditionEvaluator(cache, tree, resolver, input.Labels, input.UtcNow, stamp)
                    { Pushdown = input.Pushdown };
                    var groupEval = new ConditionGroupEvaluator(conditionEval);

                    foreach (var ruleId in input.RuleIds)
                        EvaluateRule(ruleId, root, cache, conditionEval, groupEval, null);

                    // Second runs: each changed lookup's previous record, ticked actions only. The
                    // root there is an existing record, so no new-record stamp. A rule with no
                    // action that can fire for this lookup has nothing to contribute here, so its
                    // conditions are not even evaluated a second time.
                    foreach (var run in record.PreviousRuns)
                    {
                        var previousEval = new ConditionEvaluator(run.Cache, tree, resolver, input.Labels, input.UtcNow)
                        { Pushdown = input.Pushdown };
                        var previousGroups = new ConditionGroupEvaluator(previousEval);
                        foreach (var ruleId in input.RuleIds)
                        {
                            if (!HasPreviousAction(input, ruleId, tree, run.Lookup)) continue;
                            EvaluateRule(ruleId, run.Root, run.Cache, previousEval, previousGroups, run.Lookup);
                        }
                    }

                    void EvaluateRule(Guid ruleId, Entity ruleRoot, QueryResultCache ruleCache,
                        ConditionEvaluator eval, ConditionGroupEvaluator groups, TableConfig previousOf)
                    {
                        eval.Dates = input.DatesByRule.TryGetValue(ruleId, out var dates) ? dates : null;

                        var ruleRootGroups = input.RootGroups.Where(g => g.RuleId == ruleId).ToList();

                        var executionGroups = ruleRootGroups.Where(g => g.IsExecutionCondition).ToList();
                        if (executionGroups.Any() && !executionGroups.All(g => groups.EvaluateGroup(g, ruleRoot).Passed))
                        {
                            if (previousOf == null) gated.Add(ruleId);
                            return;
                        }

                        var ruleGroups = ruleRootGroups.Where(g => !g.IsExecutionCondition).ToList();
                        // Every outcome is evaluated (no short-circuit): actions may test any of them.
                        var outcomes = new Dictionary<Guid, bool>();
                        foreach (var g in ruleGroups) outcomes[g.Id] = groups.EvaluateGroup(g, ruleRoot).Passed;

                        input.ActionsByRule.TryGetValue(ruleId, out var actions);
                        foreach (var a in ActionDispatcher.ComputeFiredActions(outcomes, actions))
                        {
                            // A second run only brings the previous record up to date: ticked Update
                            // Record actions in that lookup's branch. Everything else ran in run 1.
                            if (previousOf != null && PreviousParent.LookupFor(a, tree)?.Id != previousOf.Id) continue;

                            WriteIntent intent = null;
                            List<WriteIntent> setIntents = null;
                            if (ActionDispatcher.IsWriteAction(a.ActionType))
                            {
                                if (SetActions.IsSetAction(a, tree))
                                    setIntents = writeResolver.ResolveSet(a, Mapping(input, a), ruleRoot, ruleCache, input.Context, eval.Dates);
                                else
                                    intent = writeResolver.Resolve(a, Mapping(input, a), ruleRoot, ruleCache, input.Context);
                            }
                            // A record run 1 also resolves for this node (both parents share it) is
                            // current, not previous: run 1 owns it, so run 2 must not overwrite it.
                            if (previousOf != null && intent?.Operation == WriteOperation.Update
                                && IsRunOneTarget(cache, a, intent)) continue;
                            var result = ToResult(a, input.LanguageId, ruleRoot, ruleCache, templates, trace, intent);
                            result.PreviousOfNodeId = previousOf?.Id;
                            result.WriteIntents = setIntents;
                            fired.Add(result);
                        }
                    }
                }

                firedByRecord.Add(fired);
                gatedByRecord.Add(gated);
            }

            return new EvaluationVerdict(firedByRecord, gatedByRecord);
        }

        // The gather stage's memo holds every mapping the reference computation parsed. One it
        // does not hold is empty or malformed; parsing it here keeps the fault where it always
        // was, raised only when that action actually fires.
        private static List<FieldMappingEntry> Mapping(EvaluationInput input, RuleAction a) =>
            input.MappingsByAction.TryGetValue(a.Id, out var m) ? m : FieldMappingParser.Parse(a.FieldMapping);

        // Run 2 only ever fires a ticked action whose root-level lookup is the one that changed;
        // a rule with no such action would evaluate conditions and fire nothing, so it is skipped
        // before conditions are evaluated at all.
        private static bool HasPreviousAction(EvaluationInput input, Guid ruleId, TableConfigTree tree, TableConfig lookup) =>
            input.ActionsByRule.TryGetValue(ruleId, out var actions)
            && actions.Any(a => PreviousParent.LookupFor(a, tree)?.Id == lookup.Id);

        private static bool IsRunOneTarget(QueryResultCache runOneCache, RuleAction a, WriteIntent intent)
        {
            if (!a.TargetNodeId.HasValue || !runOneCache.Has(a.TargetNodeId.Value)) return false;
            var rows = runOneCache.Get(a.TargetNodeId.Value);
            return rows.Count == 1 && rows[0].Id == intent.TargetId;
        }

        private static FiredActionResult ToResult(
            RuleAction a,
            int languageId,
            Entity root,
            QueryResultCache cache,
            TemplateRenderer templates,
            ITracingService trace,
            WriteIntent intent = null)
        {
            var hasMessage = a.ActionType == ActionType.Block || a.ActionType == ActionType.ShowMessage;
            var hasValue = a.ActionType == ActionType.SetVisible || a.ActionType == ActionType.SetRequired;

            string message = null;
            if (hasMessage)
            {
                var raw = MessageResolver.Resolve(a, languageId);
                try
                {
                    message = templates.Render(raw, root, cache, $"message for action {a.Id}");
                }
                catch (InvalidPluginExecutionException ex)
                {
                    message = raw;
                    trace?.Trace("Message token render failed for action {0}, using raw text: {1}", a.Id, ex.Message);
                }
            }

            return new FiredActionResult
            {
                RuleId = a.RuleId,
                ActionType = a.ActionType,
                TargetColumn = a.TargetColumn,
                Value = hasValue ? a.ValueBool : (bool?)null,
                Message = message,
                Severity = a.Severity,
                TargetTable = a.TargetTable,
                WriteIntent = intent
            };
        }
    }
}
