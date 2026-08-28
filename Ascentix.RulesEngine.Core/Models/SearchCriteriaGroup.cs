using System;
using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Models
{
    // ─── Search Criteria ──────────────────────────────────────────────────────

    /// <summary>
    /// AND/OR group tree of search criteria. Self-referential.
    /// Belongs to a RuleCondition.
    /// </summary>
    public class SearchCriteriaGroup
    {
        public Guid Id { get; set; }
        public Guid RuleConditionId { get; set; }
        public Guid? ParentCriteriaGroupId { get; set; }
        public LogicalOperator LogicalOperator { get; set; }
        public List<SearchCriteriaGroup> ChildGroups { get; set; } = new List<SearchCriteriaGroup>();
        public List<SearchCriterion> Criteria { get; set; } = new List<SearchCriterion>();
    }
}
