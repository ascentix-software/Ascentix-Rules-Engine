using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// EXISTS over a SIBLING collection, the shape ruleBehaviorExists uses live (a RowCount on
    /// the order's lines, filtered by "the order has a shipment over $100"). The collection node
    /// is a different node from the condition's own node, has no condition of its own, and is a
    /// leaf, so nothing else can force its fetch: if the demand proof misses it, QueryExecutor
    /// issues no fetch at all, EvaluateExists reads an empty cache entry, and the criterion
    /// silently counts zero.
    /// </summary>
    public class PushdownExistsSiblingTests
    {
        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid LineId = Guid.NewGuid();
        private static readonly Guid ShipmentId = Guid.NewGuid();

        private static TableConfigTree Configs() => TestTree.Tree(
            new TableConfig { Id = RootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
            new TableConfig { Id = LineId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_orderid", ParentTableId = RootId },
            new TableConfig { Id = ShipmentId, TableLogicalName = "sample_shipment", ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_orderid", ParentTableId = RootId }
        );

        private static QueryExecutionPlan Plan()
        {
            var configs = Configs();
            var plan = new QueryExecutionPlan();
            plan.Levels.Add(new List<ExecutionPlanEntry>
            {
                new ExecutionPlanEntry { Node = configs.Node(LineId), ParentCacheKey = RootId.ToString() },
                new ExecutionPlanEntry { Node = configs.Node(ShipmentId), ParentCacheKey = RootId.ToString() },
            });
            return plan;
        }

        private static ExecutionPlanEntry Entry(QueryExecutionPlan plan, Guid nodeId) =>
            plan.Levels.SelectMany(l => l).First(e => e.Node.Id == nodeId);

        // The rule: RowCount(line) >= 1, where the line filter carries EXISTS(shipment, amount > 100).
        private static ConditionGroup RuleGroup(out RuleCondition condition)
        {
            condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = LineId,
                ConditionType = ConditionType.RowCount,
                MinExpectedRows = 1,
            };
            var filter = new NodeFilterGroup
            {
                TableConfigNodeId = LineId,
                RuleConditionId = condition.Id,
                LogicalOperator = LogicalOperator.And,
                Criteria =
                {
                    new NodeFilterCriterion
                    {
                        Kind = CriterionKind.Exists,
                        CollectionNodeId = ShipmentId,
                        MinCount = 1,
                        SubFilter = new NodeFilterGroup
                        {
                            TableConfigNodeId = ShipmentId,
                            LogicalOperator = LogicalOperator.And,
                            Criteria = { new NodeFilterCriterion { FieldName = "sample_shipamount", Operator = "gt", Value = "100" } },
                        },
                    },
                },
            };
            return new ConditionGroup
            {
                Id = Guid.NewGuid(),
                Conditions = new List<RuleCondition> { condition },
                NodeFilterGroups = new List<NodeFilterGroup> { filter },
            };
        }

        [Fact]
        public void Exists_over_a_sibling_collection_demands_that_collection_unfiltered()
        {
            var plan = Plan();
            var group = RuleGroup(out _);

            PushdownPlanner.Apply(plan, Configs(), new List<ConditionGroup> { group }, null);

            var shipment = Entry(plan, ShipmentId);
            Assert.True(
                shipment.DemandsUnfiltered || shipment.Variants.Any(),
                "EvaluateExists reads the shipment node's cache entry; with no unfiltered fetch and " +
                "no variant, QueryExecutor never fetches it and the criterion counts zero.");
        }

        [Fact]
        public void Exists_collection_is_demanded_even_when_the_filter_is_owned_by_another_condition()
        {
            // The runner seeds the PLAN from every node-filter group it can reach, regardless of
            // which condition owns it, so the collection always gets an execution entry. The
            // planner's demand proof, though, only inspects filters "owned" by the condition it
            // is iterating (RuleConditionId null or equal). A filter whose RuleConditionId names a
            // condition that is not in its own group therefore yields a node that is PLANNED but
            // never demanded and never varianted: QueryExecutor issues no fetch, and the EXISTS
            // arm reads an entry that was never populated.
            var plan = Plan();
            var group = RuleGroup(out _);
            group.NodeFilterGroups[0].RuleConditionId = Guid.NewGuid(); // owned by a condition elsewhere

            PushdownPlanner.Apply(plan, Configs(), new List<ConditionGroup> { group }, null);

            var shipment = Entry(plan, ShipmentId);
            Assert.True(
                shipment.DemandsUnfiltered || shipment.Variants.Any(),
                "planned but never fetched: EvaluateExists would count zero from an unpopulated entry.");
        }
    }
}
