using System;
using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Models
{
    // ─── Condition Group ──────────────────────────────────────────────────────

    public class ConditionGroup
    {
        public Guid Id { get; set; }
        public Guid RuleId { get; set; }
        public Guid? ParentConditionGroupId { get; set; }
        public LogicalOperator LogicalOperator { get; set; }

        /// <summary>
        /// When true, this group is evaluated BEFORE non-execution groups.
        /// If it fails, the entire rule is skipped.
        /// </summary>
        public bool IsExecutionCondition { get; set; }

        public List<ConditionGroup> ChildGroups { get; set; } = new List<ConditionGroup>();
        public List<RuleCondition> Conditions { get; set; } = new List<RuleCondition>();

        /// <summary>
        /// Node filters scoped to this condition group.
        /// Applied at evaluation time, not at query time.
        /// </summary>
        public List<NodeFilterGroup> NodeFilterGroups { get; set; } = new List<NodeFilterGroup>();
    }
}
