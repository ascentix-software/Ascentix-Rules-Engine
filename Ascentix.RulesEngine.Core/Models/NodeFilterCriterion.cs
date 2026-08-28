using System;

namespace Ascentix.RulesEngine.Core.Models
{
    /// <summary>A single node-filter criterion. Operator tokens: eq, ne, gt, ge, lt, le,
    /// like, not-like, contains, not-contains, null, not-null. Value-source RHS added in the
    /// value-from-record task.</summary>
    public class NodeFilterCriterion
    {
        public CriterionKind Kind { get; set; } = CriterionKind.Comparison;
        public string FieldName { get; set; }
        public string Operator { get; set; }
        public string Value { get; set; }
        // Populated by the value-from-record task; default Literal keeps back-compat.
        public ComparisonValueSource ValueSource { get; set; } = ComparisonValueSource.Literal;
        public Guid? ComparisonValueNodeId { get; set; }
        public string ComparisonValueColumn { get; set; }
        // Exists-only (null/0 for Comparison):
        public Guid? CollectionNodeId { get; set; }
        public int? MinCount { get; set; }
        public int? MaxCount { get; set; }
        public NodeFilterGroup SubFilter { get; set; }   // scalar-only criteria
    }
}
