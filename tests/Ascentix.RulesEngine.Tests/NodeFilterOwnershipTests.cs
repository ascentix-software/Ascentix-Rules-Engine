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
    /// NodeFilterGroups are scoped to a ConditionGroup (not to a single condition), but two
    /// FieldComparison conditions on the same node need independent filters. RuleConditionId
    /// attributes a filter group to ONE owning condition; ApplyNodeFilters must apply only the
    /// evaluated condition's own filters, plus legacy unowned (RuleConditionId == null) filters
    /// for back-compat, which stay group-wide across every condition on that node.
    /// </summary>
    public class NodeFilterOwnershipTests
    {
        // Root "order" node with one ChildTable "orderline" node holding category+amount rows.
        private static (ConditionEvaluator eval, Guid childNodeId) Setup(IEnumerable<Entity> lines)
        {
            var rootNodeId = Guid.NewGuid();
            var childNodeId = Guid.NewGuid();
            var rootNode = new TableConfig
            {
                Id = rootNodeId, TableLogicalName = "order",
                ConfigType = TableConfigType.RootTable,
            };
            var childNode = new TableConfig
            {
                Id = childNodeId, TableLogicalName = "orderline",
                ConfigType = TableConfigType.ChildTable, ParentTableId = rootNodeId,
                ChildLinkField = "parentid",
            };
            var configs = TestTree.Tree(rootNode, childNode);

            var cache = new QueryResultCache();
            cache.Store(rootNodeId, new List<Entity> { new Entity("order", Guid.NewGuid()) });
            cache.Store(childNodeId, new List<Entity>(lines));

            var eval = new ConditionEvaluator(cache, configs, new FieldValueResolver());
            return (eval, childNodeId);
        }

        private static Entity Line(string category, decimal amount) =>
            new Entity("orderline") { ["category"] = category, ["amount"] = amount };

        private static RuleCondition AmountGt100(Guid nodeId) => new RuleCondition
        {
            Id = Guid.NewGuid(),
            ConditionType = ConditionType.FieldComparison,
            TableConfigNodeId = nodeId,
            ComparisonColumn = "amount",
            ComparisonOperator = ComparisonOperator.GreaterThan,
            ComparisonValue = "100",
            ValueSource = ComparisonValueSource.Literal,
        };

        private static NodeFilterCriterion CategoryEquals(string value) => new NodeFilterCriterion
        {
            FieldName = "category",
            Operator = "eq",
            Value = value,
        };

        [Fact]
        public void EachCondition_SeesOnlyItsOwnFilteredSubset()
        {
            var lines = new List<Entity>
            {
                Line("A", 50m), Line("A", 60m),   // owned by condition1's filter
                Line("B", 150m), Line("B", 160m), // owned by condition2's filter
            };
            var (eval, childNodeId) = Setup(lines);

            var condition1 = AmountGt100(childNodeId);
            var condition2 = AmountGt100(childNodeId);

            var filter1 = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = childNodeId,
                LogicalOperator = LogicalOperator.And,
                RuleConditionId = condition1.Id,
                Criteria = new List<NodeFilterCriterion> { CategoryEquals("A") },
            };
            var filter2 = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = childNodeId,
                LogicalOperator = LogicalOperator.And,
                RuleConditionId = condition2.Id,
                Criteria = new List<NodeFilterCriterion> { CategoryEquals("B") },
            };

            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                NodeFilterGroups = new List<NodeFilterGroup> { filter1, filter2 },
            };

            // Condition1 must only see its own "A" subset (50, 60) -> both fail amount > 100.
            var result1 = eval.EvaluateCondition(condition1, group);
            Assert.False(result1.Passed);
            Assert.Equal(2, result1.FailedRecords.Count);
            Assert.All(result1.FailedRecords, r => Assert.Equal("A", r.GetAttributeValue<string>("category")));

            // Condition2 must only see its own "B" subset (150, 160) -> both pass amount > 100.
            var result2 = eval.EvaluateCondition(condition2, group);
            Assert.True(result2.Passed);
            Assert.Empty(result2.FailedRecords);
        }

        [Fact]
        public void UnownedFilter_AppliesGroupWideToBothConditions()
        {
            var lines = new List<Entity>
            {
                Line("A", 50m),  // excluded by the legacy group-wide filter
                Line("B", 150m), // included
            };
            var (eval, childNodeId) = Setup(lines);

            var legacyFilter = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = childNodeId,
                LogicalOperator = LogicalOperator.And,
                RuleConditionId = null, // legacy, unowned -> applies to every condition on this node
                Criteria = new List<NodeFilterCriterion> { CategoryEquals("B") },
            };

            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                NodeFilterGroups = new List<NodeFilterGroup> { legacyFilter },
            };

            var condition1 = AmountGt100(childNodeId);
            var condition2 = AmountGt100(childNodeId);

            // Both conditions only see category "B" (150) -> both pass amount > 100, even though
            // the unfiltered set (including the 50 "A" row) would have failed.
            var result1 = eval.EvaluateCondition(condition1, group);
            Assert.True(result1.Passed);
            Assert.Empty(result1.FailedRecords);

            var result2 = eval.EvaluateCondition(condition2, group);
            Assert.True(result2.Passed);
            Assert.Empty(result2.FailedRecords);
        }

        // ── Multi-level ancestor cascade ────────────────────────────────────
        //
        // ApplyNodeFilters also supports filters that target an *ancestor* of the owning
        // condition's node (not just the node itself), restricting rows top-down through
        // qualifyingIdsByNode. That path (hasAncestorFilters == true) is never exercised
        // above: both prior tests use a 2-level tree and only self-filter. These tests build
        // a 3-level order -> line -> allocation tree, put the filter on the root "order"
        // node, and own it by a condition on the leaf "allocation" node two levels down,
        // exercising the cascade through an intermediate "line" node that carries no filter
        // of its own but must still propagate the restriction inherited from its parent.
        //
        // Pure characterization of existing believed-correct code; no production change.

        private static (ConditionEvaluator eval, Guid orderNodeId, Guid allocationNodeId) SetupThreeLevelTree(
            IEnumerable<Entity> orders, IEnumerable<Entity> lines, IEnumerable<Entity> allocations)
        {
            var orderNodeId = Guid.NewGuid();
            var lineNodeId = Guid.NewGuid();
            var allocationNodeId = Guid.NewGuid();

            var orderNode = TestTree.Node(orderNodeId, "order", TableConfigType.RootTable, null);
            var lineNode = TestTree.Node(lineNodeId, "line", TableConfigType.ChildTable, orderNodeId, "orderid");
            var allocationNode = TestTree.Node(
                allocationNodeId, "allocation", TableConfigType.ChildTable, lineNodeId, "lineid");
            var configs = TestTree.Tree(orderNode, lineNode, allocationNode);

            var cache = TestTree.Cache(
                (orderNodeId, new List<Entity>(orders)),
                (lineNodeId, new List<Entity>(lines)),
                (allocationNodeId, new List<Entity>(allocations)));

            var eval = new ConditionEvaluator(cache, configs, new FieldValueResolver());
            return (eval, orderNodeId, allocationNodeId);
        }

        // Comparison threshold no allocation row can ever satisfy, so FailedRecords always
        // equals exactly the set of records that survived ApplyNodeFilters - making the
        // cascade's output directly observable instead of inferring it from Passed alone.
        private static RuleCondition NeverPasses(Guid nodeId) => new RuleCondition
        {
            Id = Guid.NewGuid(),
            ConditionType = ConditionType.FieldComparison,
            TableConfigNodeId = nodeId,
            ComparisonColumn = "amount",
            ComparisonOperator = ComparisonOperator.GreaterThan,
            ComparisonValue = "999999",
            ValueSource = ComparisonValueSource.Literal,
        };

        [Fact]
        public void AncestorFilter_TwoLevelsUp_RestrictsLeafToQualifyingOrdersDescendants()
        {
            var qualifyingOrderId = Guid.NewGuid();
            var excludedOrderId = Guid.NewGuid();
            var qualifyingLineId = Guid.NewGuid();
            var excludedLineId = Guid.NewGuid();

            var orders = new List<Entity>
            {
                TestTree.Row("order", qualifyingOrderId, ("status", "verified")),
                TestTree.Row("order", excludedOrderId, ("status", "unverified")),
            };
            var lines = new List<Entity>
            {
                TestTree.Row("line", qualifyingLineId, ("orderid", new EntityReference("order", qualifyingOrderId))),
                TestTree.Row("line", excludedLineId, ("orderid", new EntityReference("order", excludedOrderId))),
            };

            var allocUnderQualifying1 = Guid.NewGuid();
            var allocUnderQualifying2 = Guid.NewGuid();
            var allocUnderExcluded1 = Guid.NewGuid();
            var allocUnderExcluded2 = Guid.NewGuid();
            var allocations = new List<Entity>
            {
                TestTree.Row("allocation", allocUnderQualifying1,
                    ("lineid", new EntityReference("line", qualifyingLineId)), ("amount", 150m)),
                TestTree.Row("allocation", allocUnderQualifying2,
                    ("lineid", new EntityReference("line", qualifyingLineId)), ("amount", 200m)),
                TestTree.Row("allocation", allocUnderExcluded1,
                    ("lineid", new EntityReference("line", excludedLineId)), ("amount", 50m)),
                TestTree.Row("allocation", allocUnderExcluded2,
                    ("lineid", new EntityReference("line", excludedLineId)), ("amount", 60m)),
            };

            var (eval, orderNodeId, allocationNodeId) = SetupThreeLevelTree(orders, lines, allocations);
            var condition = NeverPasses(allocationNodeId);

            var ancestorFilter = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = orderNodeId,
                LogicalOperator = LogicalOperator.And,
                RuleConditionId = condition.Id,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion { FieldName = "status", Operator = "eq", Value = "verified" },
                },
            };
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                NodeFilterGroups = new List<NodeFilterGroup> { ancestorFilter },
            };

            var result = eval.EvaluateCondition(condition, group);

            // NeverPasses fails on every surviving record, so FailedRecords is exactly the
            // post-cascade set. Only the two allocations under the qualifying order's line
            // must appear; the excluded order's allocations must be filtered out entirely -
            // if the cascade failed to restrict by ancestor, all four would show up here.
            Assert.False(result.Passed);
            Assert.Equal(2, result.FailedRecords.Count);
            Assert.Contains(result.FailedRecords, r => r.Id == allocUnderQualifying1);
            Assert.Contains(result.FailedRecords, r => r.Id == allocUnderQualifying2);
            Assert.DoesNotContain(result.FailedRecords, r => r.Id == allocUnderExcluded1);
            Assert.DoesNotContain(result.FailedRecords, r => r.Id == allocUnderExcluded2);
        }

        [Fact]
        public void AncestorFilter_ExcludingEveryOrder_LeafConditionSeesZeroRows()
        {
            var order1Id = Guid.NewGuid();
            var order2Id = Guid.NewGuid();
            var line1Id = Guid.NewGuid();
            var line2Id = Guid.NewGuid();

            var orders = new List<Entity>
            {
                TestTree.Row("order", order1Id, ("status", "verified")),
                TestTree.Row("order", order2Id, ("status", "unverified")),
            };
            var lines = new List<Entity>
            {
                TestTree.Row("line", line1Id, ("orderid", new EntityReference("order", order1Id))),
                TestTree.Row("line", line2Id, ("orderid", new EntityReference("order", order2Id))),
            };
            var allocations = new List<Entity>
            {
                TestTree.Row("allocation", Guid.NewGuid(),
                    ("lineid", new EntityReference("line", line1Id)), ("amount", 150m)),
                TestTree.Row("allocation", Guid.NewGuid(),
                    ("lineid", new EntityReference("line", line2Id)), ("amount", 50m)),
            };

            var (eval, orderNodeId, allocationNodeId) = SetupThreeLevelTree(orders, lines, allocations);
            var condition = NeverPasses(allocationNodeId);

            // No order has status "archived" -> zero qualifying orders -> the restriction
            // cascades all the way down and the leaf condition should see zero rows.
            var ancestorFilter = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = orderNodeId,
                LogicalOperator = LogicalOperator.And,
                RuleConditionId = condition.Id,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion { FieldName = "status", Operator = "eq", Value = "archived" },
                },
            };
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                NodeFilterGroups = new List<NodeFilterGroup> { ancestorFilter },
            };

            var result = eval.EvaluateCondition(condition, group);

            // Passes vacuously only because zero records reached NeverPasses. If the cascade
            // failed to exclude anything, both allocations would flow through and fail.
            Assert.True(result.Passed);
            Assert.Empty(result.FailedRecords);
        }

        // ── BuildAncestorChain guard: cyclic / missing config nodes ────────
        //
        // ApplyNodeFilters calls the private BuildAncestorChain(node) for ANY condition
        // that owns at least one NodeFilterGroup on its ConditionGroup (self- or
        // ancestor-targeting) - see the `owned.Any()` early-return above the call. These
        // tests drive that reach path with a broken config tree: a ParentTableId pointing
        // at a guid absent from _configs (missing), and a ParentTableId chain that loops
        // back on itself (cyclic).

        [Fact]
        public void Node_filter_ancestor_walk_with_a_missing_node_throws_a_config_error_not_a_CLR_error()
        {
            var childNodeId = Guid.NewGuid();
            var missingParentId = Guid.NewGuid(); // deliberately never added to configs
            var childNode = TestTree.Node(
                childNodeId, "orderline", TableConfigType.ChildTable, missingParentId, "parentid");
            var configs = TestTree.RawTree(childNode);

            var cache = TestTree.Cache(
                (childNodeId, new List<Entity> { TestTree.Row("orderline", Guid.NewGuid(), ("amount", 50m)) }));
            var eval = new ConditionEvaluator(cache, configs, new FieldValueResolver());

            var condition = AmountGt100(childNodeId);
            var filter = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = childNodeId,
                LogicalOperator = LogicalOperator.And,
                RuleConditionId = condition.Id,
                Criteria = new List<NodeFilterCriterion> { CategoryEquals("A") },
            };
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                NodeFilterGroups = new List<NodeFilterGroup> { filter },
            };

            // Owned self-filter forces ApplyNodeFilters -> BuildAncestorChain(childNode).
            // childNode.ParentTableId points at a guid absent from the config tree.
            // Before the guard: raw KeyNotFoundException from _configs[...].
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => eval.EvaluateCondition(condition, group));
            Assert.Contains("missing", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void Node_filter_ancestor_walk_with_a_cyclic_parent_chain_throws_a_config_error_and_terminates()
        {
            var nodeAId = Guid.NewGuid();
            var nodeBId = Guid.NewGuid();
            // Direct two-node cycle: A's parent is B, B's parent is A.
            var nodeA = TestTree.Node(nodeAId, "orderline", TableConfigType.ChildTable, nodeBId, "parentid");
            var nodeB = TestTree.Node(nodeBId, "order", TableConfigType.ChildTable, nodeAId, "parentid");
            var configs = TestTree.RawTree(nodeA, nodeB);

            var cache = TestTree.Cache(
                (nodeAId, new List<Entity> { TestTree.Row("orderline", Guid.NewGuid(), ("amount", 50m)) }),
                (nodeBId, new List<Entity>()));
            var eval = new ConditionEvaluator(cache, configs, new FieldValueResolver());

            var condition = AmountGt100(nodeAId);
            var filter = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = nodeAId,
                LogicalOperator = LogicalOperator.And,
                RuleConditionId = condition.Id,
                Criteria = new List<NodeFilterCriterion> { CategoryEquals("A") },
            };
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                NodeFilterGroups = new List<NodeFilterGroup> { filter },
            };

            // Guard must detect the revisited node and throw rather than loop forever.
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => eval.EvaluateCondition(condition, group));
            Assert.Contains("cyclic", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
