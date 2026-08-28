using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class EvaluationContextModelTests
    {
        [Fact]
        public void EvaluationContext_has_user_and_system_values()
        {
            Assert.Equal(1, (int)RuleEvaluationContext.User);
            Assert.Equal(2, (int)RuleEvaluationContext.System);
        }

        [Fact]
        public void SchemaNames_exposes_evaluationcontext_fragment()
        {
            Assert.Equal("asx_evaluationcontext", SchemaNames.Qualify(SchemaNames.Rule.EvaluationContext));
            Assert.Equal("evaluationcontext", SchemaNames.OptionSets.EvaluationContext);
        }
    }
}
