using System;
using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Models
{
    // ─── Node Filter Groups ───────────────────────────────────────────────────

    /// <summary>
    /// AND/OR group tree of node filters. Self-referential.
    /// Scoped to a ConditionGroup (condition filters) or to a RuleAction (a set action's Rows filter).
    /// Applied at evaluation time against the in-memory cache.
    /// Can target the condition's own node, its parent, or any ancestor.
    /// </summary>
    public class NodeFilterGroup
    {
        public Guid Id { get; set; }
        public Guid ConditionGroupId { get; set; }

        /// <summary>
        /// The condition that owns this filter group. Null means legacy/unowned, in which case
        /// the filter applies group-wide to every condition targeting this node (back-compat).
        /// </summary>
        public Guid? RuleConditionId { get; set; }

        /// <summary>The action that owns this group as its Rows filter (asx_ruleaction), or null.
        /// Set on the top-level group; an action-owned filter has no condition group.</summary>
        public Guid? RuleActionId { get; set; }

        /// <summary>
        /// Which node in the config tree this filter targets.
        /// Can be the condition's own node, its parent, or any ancestor.
        /// </summary>
        public Guid TableConfigNodeId { get; set; }
        public Guid? ParentFilterGroupId { get; set; }
        public LogicalOperator LogicalOperator { get; set; }
        public List<NodeFilterGroup> ChildGroups { get; set; } = new List<NodeFilterGroup>();
        public List<NodeFilterCriterion> Criteria { get; set; } = new List<NodeFilterCriterion>();
    }
}
