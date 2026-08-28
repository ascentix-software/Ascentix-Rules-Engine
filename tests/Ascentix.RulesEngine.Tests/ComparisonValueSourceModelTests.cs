using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ComparisonValueSourceModelTests
    {
        [Fact]
        public void New_condition_defaults_to_literal_source()
        {
            Assert.Equal(ComparisonValueSource.Literal, new RuleCondition().ValueSource);
        }

        [Fact]
        public void Enum_values_are_stable()
        {
            Assert.Equal(1, (int)ComparisonValueSource.Literal);
            Assert.Equal(2, (int)ComparisonValueSource.FieldReference);
        }
    }
}
