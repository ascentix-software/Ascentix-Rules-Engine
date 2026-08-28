using System;
using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Models
{
    // ─── Rule Condition ───────────────────────────────────────────────────────

    public class RuleCondition
    {
        public Guid Id { get; set; }
        public Guid ConditionGroupId { get; set; }
        public Guid TableConfigNodeId { get; set; }

        public ConditionType ConditionType { get; set; } = ConditionType.FieldComparison;

        /// <summary>
        /// The field on the record to evaluate. Used by FieldComparison (LHS) and
        /// RegexMatch (the column tested against the pattern in <see cref="ComparisonValue"/>).
        /// </summary>
        public string ComparisonColumn { get; set; }
        public ComparisonOperator? ComparisonOperator { get; set; }
        public string ComparisonValue { get; set; }

        /// <summary>RowCount conditions only.</summary>
        public int? MinExpectedRows { get; set; }

        /// <summary>RowCount conditions only.</summary>
        public int? MaxExpectedRows { get; set; }

        /// <summary>
        /// AND/OR grouped criteria applied in-memory before row count evaluation.
        /// RowCount conditions only.
        /// </summary>
        public List<SearchCriteriaGroup> SearchCriteriaGroups { get; set; } = new List<SearchCriteriaGroup>();

        /// <summary>Where the RHS comparand comes from. Defaults to Literal.</summary>
        public ComparisonValueSource ValueSource { get; set; } = ComparisonValueSource.Literal;

        /// <summary>
        /// FieldReference only. The TableConfig node the RHS column lives on; null means
        /// the condition's own node (same-record).
        /// </summary>
        public Guid? ComparisonValueNodeId { get; set; }

        /// <summary>FieldReference only. The RHS column on the referenced node.</summary>
        public string ComparisonValueColumn { get; set; }

        /// <summary>Expression condition only: the LHS mathexpr.</summary>
        public string Expression { get; set; }
    }
}
