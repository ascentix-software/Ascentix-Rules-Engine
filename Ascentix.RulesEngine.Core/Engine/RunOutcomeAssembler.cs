using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// Dispatch: the run's fired actions, index-aligned with its inputs, become the
    /// <see cref="RuleEvaluationOutcome"/> the adapters act on. Owns the RulesFired counter,
    /// TotalMs and the "Diagnostics: …" trace.
    /// </summary>
    public static class RunOutcomeAssembler
    {
        public static RuleEvaluationOutcome Assemble(
            IList<RootInput> inputs,
            List<FiredActionResult>[] fired,
            RunDiagnostics diag,
            long totalMs,
            ITracingService trace)
        {
            var records = new List<RecordEvaluationResult>();
            for (var i = 0; i < inputs.Count; i++)
                records.Add(new RecordEvaluationResult { RecordId = inputs[i].Id, FiredActions = fired[i] });

            diag.RulesFired = records.SelectMany(r => r.FiredActions).Select(a => a.RuleId).Distinct().Count();
            diag.TotalMs = totalMs;
            trace.Trace($"Diagnostics: {diag.TotalMs}ms total, {diag.RetrieveCount} retrieves, {diag.RetrieveMultipleCount} retrieveMultiples, {diag.RowsFetched} rows.");

            return new RuleEvaluationOutcome { Records = records, Diagnostics = diag };
        }
    }
}
