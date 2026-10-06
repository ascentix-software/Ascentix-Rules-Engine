using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>Publish checks for outcomes (top-level validation groups) and actions' "Fires when" trees.</summary>
    public class OutcomeChecks
    {
        public IEnumerable<ValidationIssue> Check(RuleForValidation model)
        {
            var issues = new List<ValidationIssue>();
            var outcomes = model.Groups.Where(g => !g.IsExecutionCondition && g.ParentConditionGroupId == null).ToList();
            var outcomeIds = new HashSet<Guid>(outcomes.Select(o => o.Id));

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var o in outcomes)
            {
                var name = o.Name?.Trim();
                if (string.IsNullOrEmpty(name))
                    issues.Add(ValidationIssue.Error("OUTCOME_UNNAMED", "Name this outcome.", IssueTarget.Group(o.Id)));
                else if (!seen.Add(name))
                    issues.Add(ValidationIssue.Error("OUTCOME_DUPLICATE_NAME",
                        $"Another outcome is already named \"{name}\".", IssueTarget.Group(o.Id)));
            }

            var used = new HashSet<Guid>();
            foreach (var a in model.Actions.Where(a => a.IsActive))
            {
                if (a.Condition == null)
                {
                    issues.Add(ValidationIssue.Error("ACTION_NO_TREE", "Choose when this action fires.", IssueTarget.Action(a.Id)));
                    continue;
                }
                CheckGroup(a, a.Condition, isRoot: true, outcomeIds, used, issues);
            }

            foreach (var o in outcomes.Where(o => !used.Contains(o.Id)))
                issues.Add(ValidationIssue.Warning("OUTCOME_UNUSED",
                    "No active action uses this outcome. It is still evaluated and reported.", IssueTarget.Group(o.Id)));
            return issues;
        }

        private static void CheckGroup(RuleAction action, ActionConditionGroup group, bool isRoot, HashSet<Guid> outcomeIds,
            HashSet<Guid> used, List<ValidationIssue> issues)
        {
            var empty = group.Tests.Count == 0 && group.Groups.Count == 0;
            if (empty && !(isRoot && group.LogicalOperator == LogicalOperator.And))
                issues.Add(ValidationIssue.Error("ACTION_EMPTY_GROUP",
                    "A group in \"Fires when\" has no tests or groups.", IssueTarget.Action(action.Id)));
            foreach (var t in group.Tests)
            {
                if (t.OutcomeId.HasValue && outcomeIds.Contains(t.OutcomeId.Value)) used.Add(t.OutcomeId.Value);
                else issues.Add(ValidationIssue.Error("ACTION_TEST_UNKNOWN_OUTCOME",
                    "A test in \"Fires when\" refers to an outcome this rule doesn't have.", IssueTarget.Action(action.Id)));
            }
            foreach (var child in group.Groups) CheckGroup(action, child, isRoot: false, outcomeIds, used, issues);
        }
    }
}
