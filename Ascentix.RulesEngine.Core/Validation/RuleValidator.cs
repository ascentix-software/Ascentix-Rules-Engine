using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>
    /// Single source of truth for rule validity. Runs the three blocking layers in order and
    /// collects ALL issues (no short-circuit) so the author sees every problem at once.
    /// </summary>
    public static class RuleValidator
    {
        public static ValidationReport Validate(RuleForValidation model, IAttributeFlagsProvider metadata)
        {
            var issues = new List<ValidationIssue>();
            issues.AddRange(new StructuralChecks().Check(model));
            issues.AddRange(new TraversalChecks().Check(model));
            issues.AddRange(new MetadataChecks().Check(model, metadata));
            return ValidationReport.From(issues);
        }
    }
}
