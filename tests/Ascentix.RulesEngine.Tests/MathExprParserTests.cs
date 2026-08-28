using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class MathExprParserTests
    {
        private static decimal EvalConst(MathExprNode n)
        {
            switch (n)
            {
                case NumberNode num: return num.Value;
                case UnaryNode u: return -EvalConst(u.Operand);
                case BinaryNode b:
                    var l = EvalConst(b.Left); var r = EvalConst(b.Right);
                    switch (b.Op) { case '+': return l + r; case '-': return l - r;
                                    case '*': return l * r; default: return l / r; }
                default: throw new System.Exception("not constant");
            }
        }

        [Theory]
        [InlineData("1 + 2 * 3", 7)]        // precedence
        [InlineData("(1 + 2) * 3", 9)]      // parens
        [InlineData("10 - 2 - 3", 5)]       // left-assoc
        [InlineData("-2 * 3", -6)]          // unary minus
        [InlineData("2.5 * 4", 10)]         // decimal literal
        [InlineData("  1+1  ", 2)]          // whitespace
        public void Parses_and_respects_precedence(string expr, int expected)
        {
            Assert.Equal(expected, EvalConst(MathExpr.Parse(expr, "ctx")));
        }

        [Fact]
        public void Extracts_root_and_node_refs()
        {
            var id = System.Guid.NewGuid();
            var ast = MathExpr.Parse($"{{root.qty}} * {{node:{id}.price}} + 1", "ctx");
            var refs = MathExpr.ExtractRefs(ast).ToList();
            Assert.Contains((null, "qty"), refs.Select(r => (r.node, r.column)));
            Assert.Contains(((System.Guid?)id, "price"), refs.Select(r => (r.node, r.column)));
        }

        [Theory]
        [InlineData("")]                    // empty
        [InlineData("(1 + 2")]               // unbalanced paren
        [InlineData("1 +")]                  // trailing operator
        [InlineData("* 2")]                  // leading binary operator
        [InlineData("1 & 2")]               // unknown character
        [InlineData("{root.}")]             // missing column
        [InlineData("{node:not-a-guid.x}")] // bad guid
        [InlineData("{oops.x}")]            // unknown token prefix
        [InlineData("1..2")]                 // bad number
        public void Rejects_malformed(string expr)
        {
            Assert.Throws<InvalidPluginExecutionException>(() => MathExpr.Parse(expr, "ctx"));
        }

        [Fact]
        public void Parses_aggregate_operands_and_extracts_node()
        {
            var id = System.Guid.NewGuid();
            var ast = MathExpr.Parse($"sum(node:{id}.amount) / count(node:{id})", "ctx");
            var refs = System.Linq.Enumerable.ToList(MathExpr.ExtractRefs(ast));
            Assert.Contains(((System.Guid?)id, "amount"), refs);   // sum's node+column
            Assert.Contains(((System.Guid?)id, (string)null), refs); // count's node, no column
        }

        [Fact]
        public void Aggregate_composes_with_arithmetic()
        {
            var id = System.Guid.NewGuid();
            var ast = MathExpr.Parse($"max(node:{id}.price) * {{root.markup}} + 1", "ctx");
            Assert.NotNull(ast); // parses without throwing
        }

        [Theory]
        [InlineData("count(node:{0}.amount)")]  // count takes no column
        [InlineData("sum(node:{0})")]           // sum needs a column
        [InlineData("avg(node:not-a-guid.x)")]  // bad guid
        [InlineData("bogus(node:{0}.x)")]       // unknown function
        [InlineData("sum(root.x)")]             // aggregate arg must be a node, not root
        [InlineData("sum(node:{0}.x")]          // unclosed
        public void Rejects_malformed_aggregates(string template)
        {
            var expr = string.Format(template, System.Guid.NewGuid());
            Assert.Throws<InvalidPluginExecutionException>(() => MathExpr.Parse(expr, "ctx"));
        }
    }
}
