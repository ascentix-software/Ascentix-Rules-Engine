using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Characterizes RowCount count-mode evaluation (ConditionEvaluator.EvaluateRowCount):
    /// the "none" (max=0) and N-M range modes. Pure characterization of existing
    /// believed-correct code.
    /// </summary>
    public class ConditionEvaluatorRowCountTests
    {
        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid LineId = Guid.NewGuid();

        private static TableConfig RootNode() =>
            TestTree.Node(RootId, "order", TableConfigType.RootTable, null);

        private static TableConfig LineNode() =>
            TestTree.Node(LineId, "line", TableConfigType.ChildTable, RootId, "orderid");

        private static ConditionEvaluator Evaluator(params Entity[] lineRows)
        {
            var configs = TestTree.Tree(RootNode(), LineNode());
            // The executor seeds the root entry before any child fetch; EvaluateRowCount reads
            // it back (the warning attaches to the nearest parent), so the cache must hold it.
            var cache = TestTree.Cache(
                (RootId, new List<Entity> { TestTree.Row("order", Guid.NewGuid()) }),
                (LineId, new List<Entity>(lineRows)));
            return new ConditionEvaluator(cache, configs, new FieldValueResolver());
        }

        private static RuleCondition RowCountCondition(
            int? min, int? max, List<SearchCriteriaGroup> searchCriteriaGroups = null) =>
            new RuleCondition
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = LineId,
                ConditionType = ConditionType.RowCount,
                MinExpectedRows = min,
                MaxExpectedRows = max,
                SearchCriteriaGroups = searchCriteriaGroups ?? new List<SearchCriteriaGroup>()
            };

        private static ConditionGroup EmptyGroup() =>
            new ConditionGroup { Id = Guid.NewGuid() };

        private static Entity[] Rows(int count)
        {
            var rows = new Entity[count];
            for (var i = 0; i < count; i++)
                rows[i] = TestTree.Row("line", Guid.NewGuid());
            return rows;
        }

        [Fact]
        public void None_mode_passes_with_zero_rows()
        {
            var evaluator = Evaluator(Rows(0));
            var condition = RowCountCondition(null, 0);

            var result = evaluator.EvaluateCondition(condition, EmptyGroup());

            Assert.True(result.Passed);
        }

        [Fact]
        public void None_mode_fails_with_one_row()
        {
            var evaluator = Evaluator(Rows(1));
            var condition = RowCountCondition(null, 0);

            var result = evaluator.EvaluateCondition(condition, EmptyGroup());

            Assert.False(result.Passed);
        }

        [Theory]
        [InlineData(1, false)]
        [InlineData(2, true)]
        [InlineData(4, true)]
        [InlineData(5, false)]
        public void Range_mode_boundaries(int rowCount, bool expectedPassed)
        {
            var evaluator = Evaluator(Rows(rowCount));
            var condition = RowCountCondition(2, 4);

            var result = evaluator.EvaluateCondition(condition, EmptyGroup());

            Assert.Equal(expectedPassed, result.Passed);
        }

        [Theory]
        [InlineData(2, false)]
        [InlineData(3, true)]
        [InlineData(4, false)]
        public void Exactly_n_when_min_equals_max(int rowCount, bool expectedPassed)
        {
            var evaluator = Evaluator(Rows(rowCount));
            var condition = RowCountCondition(3, 3);

            var result = evaluator.EvaluateCondition(condition, EmptyGroup());

            Assert.Equal(expectedPassed, result.Passed);
        }

        // Characterization: validation flags this (STRUCT), but validation is advisory and the
        // runner never re-checks, so at runtime it silently always passes. Pinned, not endorsed.
        [Fact]
        public void Min_zero_is_vacuously_true()
        {
            var evaluator = Evaluator(Rows(0));
            var condition = RowCountCondition(0, null);

            var result = evaluator.EvaluateCondition(condition, EmptyGroup());

            Assert.True(result.Passed);
        }

        // Characterization: validation flags this (STRUCT), but validation is advisory and the
        // runner never re-checks, so at runtime it silently always passes. Pinned, not endorsed.
        [Fact]
        public void Both_bounds_null_always_passes()
        {
            var evaluator = Evaluator(Rows(0));
            var condition = RowCountCondition(null, null);

            var result = evaluator.EvaluateCondition(condition, EmptyGroup());

            Assert.True(result.Passed);
        }

        [Theory]
        [InlineData(2, true)]
        [InlineData(3, false)]
        public void Max_only_non_zero(int rowCount, bool expectedPassed)
        {
            var evaluator = Evaluator(Rows(rowCount));
            var condition = RowCountCondition(null, 2);

            var result = evaluator.EvaluateCondition(condition, EmptyGroup());

            Assert.Equal(expectedPassed, result.Passed);
        }

        [Fact]
        public void Search_criteria_filter_before_counting()
        {
            // 3 rows, only 1 "open" -> min=1,max=1 passes only if SearchCriteriaGroups actually
            // filtered the other 2 out before counting.
            var rows = new[]
            {
                TestTree.Row("line", Guid.NewGuid(), ("status", "open")),
                TestTree.Row("line", Guid.NewGuid(), ("status", "closed")),
                TestTree.Row("line", Guid.NewGuid(), ("status", "closed")),
            };
            var evaluator = Evaluator(rows);
            var searchCriteria = new List<SearchCriteriaGroup>
            {
                new SearchCriteriaGroup
                {
                    Id = Guid.NewGuid(),
                    LogicalOperator = LogicalOperator.And,
                    Criteria = new List<SearchCriterion>
                    {
                        new SearchCriterion { FieldName = "status", Operator = "eq", Value = "open" }
                    }
                }
            };
            var condition = RowCountCondition(1, 1, searchCriteria);

            var result = evaluator.EvaluateCondition(condition, EmptyGroup());

            Assert.True(result.Passed);
        }

        [Fact]
        public void Node_filters_apply_before_search_criteria()
        {
            // Node filter (type eq valid) runs in ApplyNodeFilters before EvaluateRowCount ever
            // sees the records; SearchCriteriaGroups (status eq open) then filters what's left.
            // If node filters did NOT run first, "open" rows across all 3 would be 2 (A and C),
            // failing min=1,max=1. A pass here proves node filters apply before search criteria.
            var rowA = TestTree.Row("line", Guid.NewGuid(), ("type", "invalid"), ("status", "open"));
            var rowB = TestTree.Row("line", Guid.NewGuid(), ("type", "valid"), ("status", "closed"));
            var rowC = TestTree.Row("line", Guid.NewGuid(), ("type", "valid"), ("status", "open"));
            var evaluator = Evaluator(rowA, rowB, rowC);

            var searchCriteria = new List<SearchCriteriaGroup>
            {
                new SearchCriteriaGroup
                {
                    Id = Guid.NewGuid(),
                    LogicalOperator = LogicalOperator.And,
                    Criteria = new List<SearchCriterion>
                    {
                        new SearchCriterion { FieldName = "status", Operator = "eq", Value = "open" }
                    }
                }
            };
            var condition = RowCountCondition(1, 1, searchCriteria);

            var nodeFilterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = LineId,
                RuleConditionId = condition.Id,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion
                    {
                        Kind = CriterionKind.Comparison,
                        FieldName = "type",
                        Operator = "eq",
                        Value = "valid"
                    }
                }
            };
            var conditionGroup = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                NodeFilterGroups = new List<NodeFilterGroup> { nodeFilterGroup }
            };

            var result = evaluator.EvaluateCondition(condition, conditionGroup);

            Assert.True(result.Passed);
        }

        [Fact]
        public void RowCount_on_a_non_child_node_throws_naming_the_condition()
        {
            var evaluator = Evaluator(Rows(0));
            var condition = RowCountCondition(null, 0);
            condition.TableConfigNodeId = RootId;

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => evaluator.EvaluateCondition(condition, EmptyGroup()));

            Assert.Contains("ChildTable", ex.Message);
            Assert.Contains(condition.Id.ToString(), ex.Message);
        }

        [Fact]
        public void RowCount_child_node_without_a_parent_throws_a_config_error_not_a_CLR_error()
        {
            var orphanId = Guid.NewGuid();
            var orphanNode = TestTree.Node(orphanId, "orphan", TableConfigType.ChildTable, null, "orderid");
            var configs = TestTree.RawTree(RootNode(), orphanNode);
            var cache = TestTree.Cache((orphanId, new List<Entity>(Rows(0))));
            var evaluator = new ConditionEvaluator(cache, configs, new FieldValueResolver());

            var condition = RowCountCondition(null, 0);
            condition.TableConfigNodeId = orphanId;

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => evaluator.EvaluateCondition(condition, EmptyGroup()));

            Assert.Contains("parent", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
