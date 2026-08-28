using Ascentix.RulesEngine.Core.Execution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class MathExprFilterKeyTests
    {
        private static AggregateNode FirstAgg(string expr)
        {
            var ast = MathExpr.Parse(expr, "test");
            return (AggregateNode)ast; // these test expressions are a single aggregate
        }

        [Fact]
        public void ParsesFilterKeyOnAggregate()
        {
            var a = FirstAgg("sum(node:11111111-1111-1111-1111-111111111111.amount filter:f1)");
            Assert.Equal("f1", a.FilterKey);
            Assert.Equal("amount", a.Column);
        }

        [Fact]
        public void UnfilteredAggregateHasNullFilterKey()
        {
            var a = FirstAgg("sum(node:11111111-1111-1111-1111-111111111111.amount)");
            Assert.Null(a.FilterKey);
        }

        [Fact]
        public void CountWithFilterKey()
        {
            var a = FirstAgg("count(node:11111111-1111-1111-1111-111111111111 filter:f2)");
            Assert.Equal("f2", a.FilterKey);
            Assert.Null(a.Column);
        }

        [Fact]
        public void MalformedFilterTermThrows()
        {
            Assert.Throws<InvalidPluginExecutionException>(() =>
                MathExpr.Parse("sum(node:11111111-1111-1111-1111-111111111111.amount filter:)", "test"));
        }

        [Fact]
        public void Tab_separates_the_filter_term()
        {
            // ParseAggArg splits on IndexOfAny(new[]{' ', '\t'}) - the tab arm is untested.
            var a = FirstAgg("sum(node:11111111-1111-1111-1111-111111111111.amount\tfilter:f1)");
            Assert.Equal("f1", a.FilterKey);
            Assert.Equal("amount", a.Column);
        }

        [Fact]
        public void Unexpected_trailing_text_throws()
        {
            // e.g. sum(node:g.amt foo:f1) -> "expected 'filter:<key>'"
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                MathExpr.Parse("sum(node:11111111-1111-1111-1111-111111111111.amount foo:f1)", "test"));
            Assert.Contains("expected 'filter:<key>'", ex.Message);
        }

        [Fact]
        public void Invalid_filter_key_characters_throw()
        {
            // e.g. filter:a-b
            Assert.Throws<InvalidPluginExecutionException>(() =>
                MathExpr.Parse("sum(node:11111111-1111-1111-1111-111111111111.amount filter:a-b)", "test"));
        }

        [Fact]
        public void Extra_token_after_the_filter_key_throws_with_the_whole_tail_named()
        {
            // Documents a sharp edge: sum(node:g.amt filter:f1 extra) makes filterKey
            // "f1 extra", which fails IsFilterKey - so the message names the whole tail as
            // the key rather than pointing at 'extra'. Pinned as-is; message quality is a
            // separate concern.
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                MathExpr.Parse("sum(node:11111111-1111-1111-1111-111111111111.amount filter:f1 extra)", "test"));
            Assert.Contains("'f1 extra'", ex.Message);
        }
    }
}
