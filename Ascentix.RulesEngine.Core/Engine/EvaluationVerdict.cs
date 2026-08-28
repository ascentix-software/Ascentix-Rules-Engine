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
        public EvaluationVerdict(IReadOnlyList<IReadOnlyList<FiredActionResult>> firedByRecord)
        {
            FiredByRecord = firedByRecord ?? throw new ArgumentNullException(nameof(firedByRecord));
        }

        public IReadOnlyList<IReadOnlyList<FiredActionResult>> FiredByRecord { get; }
    }
}
