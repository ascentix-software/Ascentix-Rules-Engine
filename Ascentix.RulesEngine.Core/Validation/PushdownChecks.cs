using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>
    /// Authoring-time pushdown advisory (TRAV_PUSHDOWN). Non-blocking: for each
    /// condition whose node filters / search criteria cannot be fully applied server-side, a
    /// warning states the runtime consequence: if more rows survive server filtering than the
    /// traversal cap, saves fail at runtime. Authors targeting big tables learn at publish
    /// time, not in production. Translates each condition with the planner's own helper
    /// (PushdownPlanner.TranslateCondition), given the same column behaviors and the rule's
    /// zone, so the warning and the runtime agree about what pushes (spec §3.5).
    /// </summary>
    public static class PushdownChecks
    {
        public const string CodePushdownResidual = "TRAV_PUSHDOWN";

        /// <summary>Without column metadata: date values read as behavior unknown.</summary>
        public static IReadOnlyList<ValidationIssue> Check(RuleForValidation model) => Check(model, null);

        /// <param name="kinds">Date column behaviors, as the runtime reads them (null ⇒ unknown).
        /// With them, date comparisons on collection filters push exactly (equality included) and
        /// a date-looking value on a column that is not a date stays in memory, as at runtime.</param>
        public static IReadOnlyList<ValidationIssue> Check(RuleForValidation model, IDateColumnKindProvider kinds)
        {
            var issues = new List<ValidationIssue>();
            if (model == null) return issues;

            // The rule's zone, as the runtime resolves it. An unknown id fails the save at runtime
            // and publish reports it (STRUCT_INVALID_TIMEZONE); here it reads as UTC.
            if (!EvaluationZone.TryResolve(EvaluationZone.SettingOf(model.RuleEntity), out var zone))
                zone = TimeZoneInfo.Utc;
            var utcNow = DateTime.UtcNow;

            foreach (var group in model.AllGroups())
            {
                foreach (var condition in group.Conditions ?? new List<RuleCondition>())
                {
                    var translated = PushdownPlanner.TranslateCondition(group, condition, model.Configs, utcNow, kinds, zone);
                    if (translated == null || !translated.HasResidual) continue;

                    var table = model.Configs != null &&
                                model.Configs.TryGetNode(condition.TableConfigNodeId, out var node)
                        ? node.TableLogicalName
                        : condition.TableConfigNodeId.ToString();

                    issues.Add(ValidationIssue.Warning(
                        CodePushdownResidual,
                        $"Some criteria on node '{table}' cannot be applied server-side and will " +
                        $"filter in memory. If more than {QueryExecutor.MaxReturnedRowsPerVariant:N0} " +
                        "rows survive server-side filtering, saves on this rule's table will fail " +
                        "at runtime. Prefer literal comparison criteria (eq/ne/gt/ge/lt/le/" +
                        "null/not-null; for dates, before/after comparisons) on large collections; " +
                        "see Beta Limitations.",
                        IssueTarget.Condition(condition.Id)));
                }
            }

            return issues;
        }
    }
}
