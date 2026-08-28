using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class NodeFilterOperatorTests
    {
        private static NodeFilterGroup Group(params NodeFilterCriterion[] crit) =>
            new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion>(crit) };

        private static NodeFilterCriterion C(string field, string op, string val) =>
            new NodeFilterCriterion { FieldName = field, Operator = op, Value = val };

        private static Entity Rec(string field, object val)
        {
            var e = new Entity("x"); e[field] = val; return e;
        }

        [Theory]
        [InlineData("gt", 100, true)]   // 150 > 100
        [InlineData("ge", 150, true)]   // 150 >= 150
        [InlineData("lt", 100, false)]  // 150 < 100 is false
        [InlineData("le", 150, true)]   // 150 <= 150
        public void NumericOrderingOperators(string op, int expected, bool matches)
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group(C("amount", op, expected.ToString()));
            Assert.Equal(matches, eval.EvaluateFilterGroup(g, new List<Entity> { Rec("amount", 150m) }));
        }

        [Fact]
        public void DateOrderingOperator()
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group(C("due", "lt", "2026-07-14"));
            Assert.True(eval.EvaluateFilterGroup(g, new List<Entity> { Rec("due", "2026-01-01") }));
        }

        [Theory]
        [InlineData("ne", "open", false)]
        [InlineData("ne", "closed", true)]
        [InlineData("like", "pe", true)]
        [InlineData("not-like", "pe", false)]
        [InlineData("contains", "op", true)]
        [InlineData("not-contains", "zz", true)]
        public void ScalarOperatorMatrix(string op, string value, bool expected)
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group(C("status", op, value));
            Assert.Equal(expected, eval.EvaluateFilterGroup(g, new List<Entity> { Rec("status", "open") }));
        }

        [Fact]
        public void NullOperator()
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group(C("status", "null", null));
            Assert.False(eval.EvaluateFilterGroup(g, new List<Entity> { Rec("status", "open") }));
            // absent attribute resolves to null
            var gMissing = Group(C("missing", "null", null));
            Assert.True(eval.EvaluateFilterGroup(gMissing, new List<Entity> { Rec("status", "open") }));
        }

        [Fact]
        public void NotNullOperator()
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group(C("status", "not-null", null));
            Assert.True(eval.EvaluateFilterGroup(g, new List<Entity> { Rec("status", "open") }));
            // absent attribute resolves to null -> not-null is false
            var gMissing = Group(C("missing", "not-null", null));
            Assert.False(eval.EvaluateFilterGroup(gMissing, new List<Entity> { Rec("status", "open") }));
        }

        [Fact]
        public void Unsupported_operator_throws_naming_the_operator()
        {
            // Reachable: ConditionGroupMapper copies asx_operator verbatim with no whitelist,
            // so a typo'd operator aborts the rule run here rather than at load.
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group(C("status", "startswith", "o"));
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => eval.EvaluateFilterGroup(g, new List<Entity> { Rec("status", "open") }));
            Assert.Contains("startswith", ex.Message);
        }

        [Fact]
        public void Comparison_criterion_without_a_field_name_throws_a_config_error()
        {
            // Reachable: ConditionGroupMapper can produce a null FieldName, and StructuralChecks
            // never requires one on a Comparison criterion. Before the guard, record.Contains(null)
            // throws a bare ArgumentNullException.
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group(C(null, "eq", "x"));
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => eval.EvaluateFilterGroup(g, new List<Entity> { Rec("status", "open") }));
            Assert.Contains("column", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
