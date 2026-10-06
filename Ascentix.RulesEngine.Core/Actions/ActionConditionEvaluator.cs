using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Actions
{
    /// <summary>Evaluates an action's "Fires when" tree against the rule's outcomes for one record.</summary>
    public static class ActionConditionEvaluator
    {
        /// <summary>
        /// True when the tree holds. No tree never fires. A test whose outcome is missing or not one of
        /// <paramref name="outcomes"/> is false. Empty ALL is true, empty ANY is false.
        /// </summary>
        public static bool Fires(ActionConditionGroup root, IReadOnlyDictionary<Guid, bool> outcomes) =>
            root != null && Holds(root, outcomes);

        private static bool Holds(ActionConditionGroup group, IReadOnlyDictionary<Guid, bool> outcomes)
        {
            var results = group.Tests.Select(t => Holds(t, outcomes)).Concat(group.Groups.Select(g => Holds(g, outcomes)));
            return group.LogicalOperator == LogicalOperator.Or ? results.Any(r => r) : results.All(r => r);
        }

        private static bool Holds(ActionConditionTest test, IReadOnlyDictionary<Guid, bool> outcomes) =>
            test.OutcomeId.HasValue && outcomes.TryGetValue(test.OutcomeId.Value, out var value) && value == test.Expected;
    }
}
