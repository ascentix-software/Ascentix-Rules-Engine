using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>
    /// Reads a rule's per-rule evaluation context (asx_evaluationcontext) off the rule Entity.
    /// Defaults to <see cref="RuleEvaluationContext.User"/> when unset (preserves prior plugin
    /// behavior). Pure, therefore unit-testable. Mirrors <see cref="RuleScheduleFilter"/>.
    /// </summary>
    public static class RuleEvaluationContextResolver
    {
        private static readonly string Field = SchemaNames.Qualify(SchemaNames.Rule.EvaluationContext);

        public static RuleEvaluationContext Resolve(Entity rule)
        {
            var value = rule.GetAttributeValue<OptionSetValue>(Field);
            if (value == null) return RuleEvaluationContext.User;
            return value.Value == (int)RuleEvaluationContext.System
                ? RuleEvaluationContext.System
                : RuleEvaluationContext.User;
        }
    }
}
