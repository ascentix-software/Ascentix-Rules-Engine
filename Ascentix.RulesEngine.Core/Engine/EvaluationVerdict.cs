using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// What <see cref="BucketEvaluator"/> decided for one <see cref="EvaluationInput"/>: the
    /// fired actions per record, position-aligned with <see cref="EvaluationInput.Records"/>
    /// (entry k belongs to Records[k]; use that record's Index to place it in the run).
    /// </summary>
    public sealed class EvaluationVerdict
    {
        public EvaluationVerdict(
            IReadOnlyList<IReadOnlyList<FiredActionResult>> firedByRecord,
            IReadOnlyList<IReadOnlyList<Guid>> gatedByRecord)
        {
            FiredByRecord = firedByRecord ?? throw new ArgumentNullException(nameof(firedByRecord));
            GatedByRecord = gatedByRecord ?? throw new ArgumentNullException(nameof(gatedByRecord));
        }

        public IReadOnlyList<IReadOnlyList<FiredActionResult>> FiredByRecord { get; }

        /// <summary>Per record (same alignment as <see cref="FiredByRecord"/>): ids of rules whose
        /// execution conditions did not pass, so the rule never evaluated for that record.</summary>
        public IReadOnlyList<IReadOnlyList<Guid>> GatedByRecord { get; }
    }
}
