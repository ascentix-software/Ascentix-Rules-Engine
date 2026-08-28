using System.Collections.Generic;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Models
{
    // ─── Evaluation Results ───────────────────────────────────────────────────

    public class ConditionEvaluationResult
    {
        public bool Passed { get; set; }

        /// <summary>
        /// The specific Dataverse records that failed this condition.
        /// Used to set the polymorphic lookup on warning records.
        /// For RowCount: the nearest parent records.
        /// For Root/Lookup FieldComparison: the triggering record.
        /// For Child FieldComparison/Format: the specific child records that failed.
        /// </summary>
        public List<Microsoft.Xrm.Sdk.Entity> FailedRecords { get; set; } = new List<Microsoft.Xrm.Sdk.Entity>();
    }

    public class GroupEvaluationResult
    {
        public bool Passed { get; set; }
        public List<ConditionEvaluationResult> FailedConditions { get; set; } = new List<ConditionEvaluationResult>();
    }
}
