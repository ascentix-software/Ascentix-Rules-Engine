using System;
using System.Collections.Generic;
using System.Linq;

namespace Ascentix.RulesEngine.Core.Models
{
    // ─── Rule Evaluation Results (returned by RulesEngineRunner) ──────────────

    /// <summary>One fired action for one record. Message is the localized text for
    /// Block/ShowMessage (else null); Value carries the SetVisible/SetRequired bool (else null).</summary>
    public class FiredActionResult
    {
        public Guid RuleId { get; set; }
        public ActionType ActionType { get; set; }
        public ActionFireOn FireOn { get; set; }
        public string TargetColumn { get; set; }
        public bool? Value { get; set; }
        public string Message { get; set; }
        public Severity? Severity { get; set; }
        public string TargetTable { get; set; }
        public WriteIntent WriteIntent { get; set; }
    }

    /// <summary>All actions that fired for a single root record.</summary>
    public class RecordEvaluationResult
    {
        public Guid RecordId { get; set; }
        public IList<FiredActionResult> FiredActions { get; set; } = new List<FiredActionResult>();

        public bool HasBlock => FiredActions.Any(a => a.ActionType == ActionType.Block);

        public IEnumerable<string> BlockingMessages =>
            FiredActions.Where(a => a.ActionType == ActionType.Block).Select(a => a.Message);
    }

    /// <summary>Evaluation result across all evaluated records.</summary>
    public class RuleEvaluationOutcome
    {
        public IList<RecordEvaluationResult> Records { get; set; } = new List<RecordEvaluationResult>();

        /// <summary>Per-run profiling data (always populated; serialized only on request).</summary>
        public Ascentix.RulesEngine.Core.Diagnostics.RunDiagnostics Diagnostics { get; set; }

        public bool IsValid => !Records.Any(r => r.HasBlock);

        public int FailedRuleCount => Records
            .SelectMany(r => r.FiredActions)
            .Where(a => a.ActionType == ActionType.Block)
            .Select(a => a.RuleId)
            .Distinct()
            .Count();

        public IEnumerable<string> BlockingMessages => Records.SelectMany(r => r.BlockingMessages);
    }
}
