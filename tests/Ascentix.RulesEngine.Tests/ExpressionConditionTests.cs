using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Covers ConditionEvaluator's ConditionType.Expression path: a mathexpr LHS (evaluated via
    /// MathExprEvaluator against the root + child-collection cache) compared to a decimal RHS
    /// resolved via ComparisonValueResolver.
    /// </summary>
    public class ExpressionConditionTests
    {
        // Root node ("account") with one ChildTable node ("sample_orderline") holding `amt` rows.
        private static (ConditionEvaluator eval, Guid rootNodeId, Guid childNodeId, Entity root) Setup(
            IEnumerable<decimal> childAmounts)
        {
            var rootNodeId = Guid.NewGuid();
            var childNodeId = Guid.NewGuid();
            var rootNode = new TableConfig
            {
                Id = rootNodeId, TableLogicalName = "account",
                ConfigType = TableConfigType.RootTable,
            };
            var childNode = new TableConfig
            {
                Id = childNodeId, TableLogicalName = "sample_orderline",
                ConfigType = TableConfigType.ChildTable, ParentTableId = rootNodeId,
                ChildLinkField = "parentid",
            };
            var configs = TestTree.Tree(rootNode, childNode);

            var root = new Entity("account", Guid.NewGuid());
            var cache = new QueryResultCache();
            cache.Store(rootNodeId, new List<Entity> { root });

            var childRows = new List<Entity>();
            foreach (var amt in childAmounts)
                childRows.Add(new Entity("sample_orderline") { ["amt"] = amt });
            cache.Store(childNodeId, childRows);

            var eval = new ConditionEvaluator(cache, configs, new FieldValueResolver());
            return (eval, rootNodeId, childNodeId, root);
        }

        private static RuleCondition ExprCond(
            Guid rootNodeId, string expression, ComparisonOperator op, string comparisonValue)
            => new RuleCondition
            {
                Id = Guid.NewGuid(),
                ConditionType = ConditionType.Expression,
                TableConfigNodeId = rootNodeId,
                Expression = expression,
                ComparisonOperator = op,
                ValueSource = ComparisonValueSource.Literal,
                ComparisonValue = comparisonValue,
            };

        private static ConditionGroup Group() =>
            new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup>() };

        [Fact]
        public void Sum_greater_than_literal_passes_when_sum_exceeds_threshold()
        {
            var (eval, rootNodeId, childNodeId, root) = Setup(new[] { 10m, 15m }); // sum = 25
            var condition = ExprCond(rootNodeId, $"sum(node:{childNodeId}.amt)", ComparisonOperator.GreaterThan, "20");

            var result = eval.EvaluateCondition(condition, Group(), root);

            Assert.True(result.Passed);
            Assert.Empty(result.FailedRecords);
        }

        [Fact]
        public void Sum_greater_than_literal_fails_when_sum_does_not_exceed_threshold()
        {
            var (eval, rootNodeId, childNodeId, root) = Setup(new[] { 5m, 10m }); // sum = 15
            var condition = ExprCond(rootNodeId, $"sum(node:{childNodeId}.amt)", ComparisonOperator.GreaterThan, "20");

            var result = eval.EvaluateCondition(condition, Group(), root);

            Assert.False(result.Passed);
            Assert.Equal(new List<Entity> { root }, result.FailedRecords);
        }

        [Fact]
        public void Avg_over_empty_collection_is_not_satisfied()
        {
            var (eval, rootNodeId, childNodeId, root) = Setup(Array.Empty<decimal>()); // no rows -> avg = null
            var condition = ExprCond(rootNodeId, $"avg(node:{childNodeId}.amt)", ComparisonOperator.GreaterThan, "0");

            var result = eval.EvaluateCondition(condition, Group(), root);

            Assert.False(result.Passed);
            Assert.Equal(new List<Entity> { root }, result.FailedRecords);
        }

        [Fact]
        public void Null_rhs_is_not_satisfied()
        {
            var (eval, rootNodeId, childNodeId, root) = Setup(new[] { 10m, 15m }); // sum = 25, would otherwise pass
            var condition = ExprCond(rootNodeId, $"sum(node:{childNodeId}.amt)", ComparisonOperator.GreaterThan, null);

            var result = eval.EvaluateCondition(condition, Group(), root);

            Assert.False(result.Passed);
            Assert.Equal(new List<Entity> { root }, result.FailedRecords);
        }

        [Fact]
        public void Count_with_literal_rhs_passes_when_at_least_one_row()
        {
            var (eval, rootNodeId, childNodeId, root) = Setup(new[] { 1m }); // count = 1
            var condition = ExprCond(rootNodeId, $"count(node:{childNodeId})", ComparisonOperator.GreaterThanOrEqual, "1");

            var result = eval.EvaluateCondition(condition, Group(), root);

            Assert.True(result.Passed);
        }

        [Fact]
        public void Count_with_literal_rhs_fails_when_no_rows()
        {
            var (eval, rootNodeId, childNodeId, root) = Setup(Array.Empty<decimal>()); // count = 0
            var condition = ExprCond(rootNodeId, $"count(node:{childNodeId})", ComparisonOperator.GreaterThanOrEqual, "1");

            var result = eval.EvaluateCondition(condition, Group(), root);

            Assert.False(result.Passed);
        }

        [Fact]
        public void Blank_expression_is_not_satisfied_and_does_not_throw()
        {
            // Regression: EvaluateExpression called MathExpr.Parse(condition.Expression, ...)
            // unguarded, so a null/blank Expression threw and aborted the whole run instead of
            // yielding "not satisfied", inconsistent with the "no value -> not satisfied"
            // contract honored by the sibling seeding/collector guards.
            var (eval, rootNodeId, _, root) = Setup(Array.Empty<decimal>());
            var condition = ExprCond(rootNodeId, "   ", ComparisonOperator.GreaterThan, "0");

            var result = eval.EvaluateCondition(condition, Group(), root);

            Assert.False(result.Passed);
            Assert.Equal(new List<Entity> { root }, result.FailedRecords);
        }
    }
}
