using System;
using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Models
{
    /// <summary>
    /// A node of an action's "Fires when" tree (asx_actionconditiongroup, docs/Schema.md §2.18): ALL (And) needs
    /// every child true, ANY (Or) needs one. A root ALL with no children is "Always, when the rule runs".
    /// </summary>
    public class ActionConditionGroup
    {
        public Guid Id { get; set; }
        public LogicalOperator LogicalOperator { get; set; } = LogicalOperator.And;
        public int Order { get; set; }
        public List<ActionConditionGroup> Groups { get; set; } = new List<ActionConditionGroup>();
        public List<ActionConditionTest> Tests { get; set; } = new List<ActionConditionTest>();

        public static ActionConditionGroup Always() => new ActionConditionGroup { LogicalOperator = LogicalOperator.And };
    }

    /// <summary>A leaf (asx_actionconditiontest): "outcome is true" (Expected) or "is false".</summary>
    public class ActionConditionTest
    {
        public Guid Id { get; set; }
        /// <summary>A top-level validation group of the same rule; null when the outcome was deleted.</summary>
        public Guid? OutcomeId { get; set; }
        public bool Expected { get; set; }
        public int Order { get; set; }
    }
}
