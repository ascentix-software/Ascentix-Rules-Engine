using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Evaluation
{
    // ─── Condition Group Evaluator ────────────────────────────────────────────

    /// <summary>
    /// Recursively evaluates a ConditionGroup tree.
    /// Applies the group's LogicalOperator across all direct conditions and child groups.
    /// Returns a GroupEvaluationResult with Passed status and all FailedConditions.
    /// </summary>
    public class ConditionGroupEvaluator
    {
        private readonly ConditionEvaluator _conditionEvaluator;

        public ConditionGroupEvaluator(ConditionEvaluator conditionEvaluator)
        {
            _conditionEvaluator = conditionEvaluator;
        }

        public GroupEvaluationResult EvaluateGroup(ConditionGroup group, Entity root = null)
        {
            var conditionResults = new List<ConditionEvaluationResult>();

            foreach (var condition in group.Conditions)
                conditionResults.Add(
                    _conditionEvaluator.EvaluateCondition(condition, group, root));

            foreach (var childGroup in group.ChildGroups)
            {
                var childResult = EvaluateGroup(childGroup, root);
                conditionResults.AddRange(childResult.FailedConditions);
            }

            var passed = group.LogicalOperator switch
            {
                LogicalOperator.And => conditionResults.All(r => r.Passed),
                LogicalOperator.Or => conditionResults.Any(r => r.Passed),
                _ => throw new InvalidPluginExecutionException(
                    $"Unsupported LogicalOperator on condition group {group.Id}")
            };

            return new GroupEvaluationResult
            {
                Passed = passed,
                FailedConditions = conditionResults.Where(r => !r.Passed).ToList()
            };
        }
    }
}
