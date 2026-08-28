using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Validation;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ComparisonOperatorSupportTests
    {
        private static readonly ComparisonOperator[] Eq = { ComparisonOperator.Equals, ComparisonOperator.NotEquals, ComparisonOperator.IsNull, ComparisonOperator.IsNotNull };
        private static readonly ComparisonOperator[] Ordered = {
            ComparisonOperator.Equals, ComparisonOperator.NotEquals,
            ComparisonOperator.GreaterThan, ComparisonOperator.GreaterThanOrEqual,
            ComparisonOperator.LessThan, ComparisonOperator.LessThanOrEqual,
            ComparisonOperator.IsNull, ComparisonOperator.IsNotNull };
        private static readonly ComparisonOperator[] Text = {
            ComparisonOperator.Equals, ComparisonOperator.NotEquals,
            ComparisonOperator.Contains, ComparisonOperator.DoesNotContain,
            ComparisonOperator.IsNull, ComparisonOperator.IsNotNull };

        [Theory]
        [InlineData(AttributeTypeCode.Integer)]
        [InlineData(AttributeTypeCode.BigInt)]
        [InlineData(AttributeTypeCode.Decimal)]
        [InlineData(AttributeTypeCode.Double)]
        [InlineData(AttributeTypeCode.Money)]
        [InlineData(AttributeTypeCode.DateTime)]
        public void Numeric_and_datetime_allow_ordering(AttributeTypeCode t)
            => Assert.Equal(Ordered.OrderBy(x => x), ComparisonOperatorSupport.For(t).OrderBy(x => x));

        [Theory]
        [InlineData(AttributeTypeCode.String)]
        [InlineData(AttributeTypeCode.Memo)]
        [InlineData(AttributeTypeCode.Virtual)] // multiselect → same set as text (Eq/NotEq/Contains/DoesNotContain/null)
        public void Text_and_multiselect_allow_contains_not_ordering(AttributeTypeCode t)
            => Assert.Equal(Text.OrderBy(x => x), ComparisonOperatorSupport.For(t).OrderBy(x => x));

        [Theory]
        [InlineData(AttributeTypeCode.Boolean)]
        [InlineData(AttributeTypeCode.Picklist)]
        [InlineData(AttributeTypeCode.State)]
        [InlineData(AttributeTypeCode.Status)]
        [InlineData(AttributeTypeCode.Lookup)]
        [InlineData(AttributeTypeCode.Customer)]
        [InlineData(AttributeTypeCode.Owner)]
        public void Equality_only_types(AttributeTypeCode t)
            => Assert.Equal(Eq.OrderBy(x => x), ComparisonOperatorSupport.For(t).OrderBy(x => x));

        [Fact]
        public void Unknown_type_falls_back_to_text_set()
            => Assert.Equal(Text.OrderBy(x => x), ComparisonOperatorSupport.For(AttributeTypeCode.PartyList).OrderBy(x => x));

        [Fact]
        public void IsAllowed_matches_For()
        {
            Assert.True(ComparisonOperatorSupport.IsAllowed(AttributeTypeCode.String, ComparisonOperator.Contains));
            Assert.False(ComparisonOperatorSupport.IsAllowed(AttributeTypeCode.String, ComparisonOperator.GreaterThan));
            Assert.False(ComparisonOperatorSupport.IsAllowed(AttributeTypeCode.Picklist, ComparisonOperator.GreaterThan));
            Assert.True(ComparisonOperatorSupport.IsAllowed(AttributeTypeCode.DateTime, ComparisonOperator.LessThanOrEqual));
        }

        private static readonly ComparisonOperator[] Numeric = {
            ComparisonOperator.Equals, ComparisonOperator.NotEquals,
            ComparisonOperator.GreaterThan, ComparisonOperator.GreaterThanOrEqual,
            ComparisonOperator.LessThan, ComparisonOperator.LessThanOrEqual };

        [Fact]
        public void ForExpression_is_numeric_only_no_null_checks_no_contains()
            => Assert.Equal(Numeric.OrderBy(x => x), ComparisonOperatorSupport.ForExpression.OrderBy(x => x));

        [Fact]
        public void IsAllowedForExpression_matches_ForExpression()
        {
            Assert.True(ComparisonOperatorSupport.IsAllowedForExpression(ComparisonOperator.GreaterThan));
            Assert.True(ComparisonOperatorSupport.IsAllowedForExpression(ComparisonOperator.Equals));
            Assert.False(ComparisonOperatorSupport.IsAllowedForExpression(ComparisonOperator.Contains));
            Assert.False(ComparisonOperatorSupport.IsAllowedForExpression(ComparisonOperator.DoesNotContain));
            Assert.False(ComparisonOperatorSupport.IsAllowedForExpression(ComparisonOperator.IsNull));
            Assert.False(ComparisonOperatorSupport.IsAllowedForExpression(ComparisonOperator.IsNotNull));
        }
    }
}
