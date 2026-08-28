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
    /// Covers MathExprEvaluator.ResolveAggregate filtering child rows (via NodeFilterEvaluator +
    /// AggregateNode.FilterKey) before reducing. Cache/config scaffolding modeled on
    /// MathExprEvaluatorTests.ChildSetup; filter-group scaffolding modeled on
    /// NodeFilterValueSourceTests.
    /// </summary>
    public class MathExprFilteredAggregateTests
    {
        private static (TableConfigTree configs, Guid rootId, Guid childId, QueryResultCache cache) ChildSetup(
            Entity root, params Entity[] rows)
        {
            var rootId = Guid.NewGuid(); var childId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = childId, TableLogicalName = "sample_orderline",
                    ConfigType = TableConfigType.ChildTable, ParentTableId = rootId }
            );
            var cache = new QueryResultCache();
            cache.Store(rootId, new List<Entity> { root });
            cache.Store(childId, new List<Entity>(rows));
            return (configs, rootId, childId, cache);
        }

        private static NodeFilterGroup StatusEquals(int value) => new NodeFilterGroup
        {
            LogicalOperator = LogicalOperator.And,
            Criteria = new List<NodeFilterCriterion>
            {
                new NodeFilterCriterion { FieldName = "statuscode", Operator = "eq", Value = value.ToString() },
            },
        };

        private static decimal? Eval(string expr, Entity root, QueryResultCache cache,
            TableConfigTree configs, IReadOnlyDictionary<string, NodeFilterGroup> filters,
            NodeFilterEvaluator filterEval)
        {
            var ast = MathExpr.Parse(expr, "ctx");
            return MathExprEvaluator.TryEvaluate(ast, root, cache, configs, "ctx", filters, filterEval, out var r)
                ? (decimal?)r
                : null;
        }

        [Fact]
        public void Filtered_sum_and_count_only_reduce_matching_rows()
        {
            var (configs, _, cid, cache) = ChildSetup(new Entity("sample_order"),
                new Entity("sample_orderline") { ["amt"] = new Money(10m), ["statuscode"] = 1 },
                new Entity("sample_orderline") { ["amt"] = new Money(20m), ["statuscode"] = 1 },
                new Entity("sample_orderline") { ["amt"] = new Money(30m), ["statuscode"] = 2 });
            var root = new Entity("sample_order");
            var filters = new Dictionary<string, NodeFilterGroup> { ["f1"] = StatusEquals(1) };
            var filterEval = new NodeFilterEvaluator(new FieldValueResolver(), null, cache, configs);

            Assert.Equal(30m, Eval($"sum(node:{cid}.amt filter:f1)", root, cache, configs, filters, filterEval));
            Assert.Equal(2m, Eval($"count(node:{cid} filter:f1)", root, cache, configs, filters, filterEval));
        }

        [Fact]
        public void Filtered_min_and_max_reduce_only_the_filtered_rows()
        {
            // Rows are 10, 50, 30; the filter keeps only 10 and 30 - removing the row that
            // holds the unfiltered max (50). If ResolveAggregate applied Where() after
            // reducing (or not at all), max would still come back 50 instead of 30.
            var (configs, _, cid, cache) = ChildSetup(new Entity("sample_order"),
                new Entity("sample_orderline") { ["amt"] = new Money(10m), ["statuscode"] = 1 },
                new Entity("sample_orderline") { ["amt"] = new Money(50m), ["statuscode"] = 2 },
                new Entity("sample_orderline") { ["amt"] = new Money(30m), ["statuscode"] = 1 });
            var root = new Entity("sample_order");
            var filters = new Dictionary<string, NodeFilterGroup> { ["f1"] = StatusEquals(1) };
            var filterEval = new NodeFilterEvaluator(new FieldValueResolver(), null, cache, configs);

            Assert.Equal(30m, Eval($"max(node:{cid}.amt filter:f1)", root, cache, configs, filters, filterEval));
            Assert.Equal(10m, Eval($"min(node:{cid}.amt filter:f1)", root, cache, configs, filters, filterEval));
        }

        [Fact]
        public void Filtered_zero_matches_sum_and_count_are_zero_avg_is_no_value()
        {
            var (configs, _, cid, cache) = ChildSetup(new Entity("sample_order"),
                new Entity("sample_orderline") { ["amt"] = new Money(10m), ["statuscode"] = 2 },
                new Entity("sample_orderline") { ["amt"] = new Money(20m), ["statuscode"] = 2 });
            var root = new Entity("sample_order");
            var filters = new Dictionary<string, NodeFilterGroup> { ["f1"] = StatusEquals(1) }; // matches nothing
            var filterEval = new NodeFilterEvaluator(new FieldValueResolver(), null, cache, configs);

            Assert.Equal(0m, Eval($"sum(node:{cid}.amt filter:f1)", root, cache, configs, filters, filterEval));
            Assert.Equal(0m, Eval($"count(node:{cid} filter:f1)", root, cache, configs, filters, filterEval));
            Assert.Null(Eval($"avg(node:{cid}.amt filter:f1)", root, cache, configs, filters, filterEval));
        }

        [Fact]
        public void FieldReference_filter_leaf_resolves_against_root_column()
        {
            var root = new Entity("sample_order") { ["sample_threshold"] = 1 };
            var (configs, rootId, cid, cache) = ChildSetup(root,
                new Entity("sample_orderline") { ["amt"] = new Money(10m), ["statuscode"] = 1 },
                new Entity("sample_orderline") { ["amt"] = new Money(30m), ["statuscode"] = 2 });

            var filterGroup = new NodeFilterGroup
            {
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion
                    {
                        FieldName = "statuscode",
                        Operator = "eq",
                        ValueSource = ComparisonValueSource.FieldReference,
                        ComparisonValueNodeId = rootId,
                        ComparisonValueColumn = "sample_threshold",
                    },
                },
            };
            var filters = new Dictionary<string, NodeFilterGroup> { ["f1"] = filterGroup };

            var resolver = new FieldValueResolver();
            var valueResolver = new ComparisonValueResolver(cache, configs, resolver);
            var filterEval = new NodeFilterEvaluator(resolver, valueResolver, cache, configs);

            Assert.Equal(10m, Eval($"sum(node:{cid}.amt filter:f1)", root, cache, configs, filters, filterEval));
        }

        [Fact]
        public void Unfiltered_aggregate_still_reduces_all_rows_even_when_filters_supplied()
        {
            var (configs, _, cid, cache) = ChildSetup(new Entity("sample_order"),
                new Entity("sample_orderline") { ["amt"] = new Money(10m), ["statuscode"] = 1 },
                new Entity("sample_orderline") { ["amt"] = new Money(30m), ["statuscode"] = 2 });
            var root = new Entity("sample_order");
            var filters = new Dictionary<string, NodeFilterGroup> { ["f1"] = StatusEquals(1) };
            var filterEval = new NodeFilterEvaluator(new FieldValueResolver(), null, cache, configs);

            Assert.Equal(40m, Eval($"sum(node:{cid}.amt)", root, cache, configs, filters, filterEval));
        }

        [Fact]
        public void Undefined_filter_key_throws()
        {
            var (configs, _, cid, cache) = ChildSetup(new Entity("sample_order"),
                new Entity("sample_orderline") { ["amt"] = new Money(10m), ["statuscode"] = 1 });
            var root = new Entity("sample_order");
            var filterEval = new NodeFilterEvaluator(new FieldValueResolver(), null, cache, configs);

            Assert.Throws<InvalidPluginExecutionException>(() =>
                Eval($"sum(node:{cid}.amt filter:missing)", root, cache, configs,
                    new Dictionary<string, NodeFilterGroup>(), filterEval));
        }

        [Fact]
        public void Back_compat_overload_still_works_unfiltered()
        {
            var (configs, _, cid, cache) = ChildSetup(new Entity("sample_order"),
                new Entity("sample_orderline") { ["amt"] = new Money(10m) },
                new Entity("sample_orderline") { ["amt"] = new Money(30m) });
            var root = new Entity("sample_order");
            var ast = MathExpr.Parse($"sum(node:{cid}.amt)", "ctx");

            Assert.True(MathExprEvaluator.TryEvaluate(ast, root, cache, configs, "ctx", out var result));
            Assert.Equal(40m, result);
        }

        [Fact]
        public void Aggregate_filter_containing_an_exists_criterion_evaluates_end_to_end()
        {
            // A fixture built on the 1-arg ctor (null cache) makes any EXISTS in an aggregate
            // filter NRE inside EvaluateExists. Production always passes cache+configs
            // (WriteIntentResolver), so the fixture here must do the same.
            // sum(node:line.amount filter:f1) where f1 = EXISTS(shipment, min 1)
            var orderId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var shipmentId = Guid.NewGuid();
            var configs = TestTree.Tree(
                TestTree.Node(orderId, "sample_order", TableConfigType.RootTable, null),
                TestTree.Node(lineId, "sample_orderline", TableConfigType.ChildTable, orderId, "line_orderid"),
                TestTree.Node(shipmentId, "sample_shipment", TableConfigType.ChildTable, orderId, "shipment_orderid"));

            // Two orders: order1 has a qualifying (expedited) shipment, order2 has none.
            var order1 = TestTree.Row("sample_order", Guid.NewGuid());
            var order2 = TestTree.Row("sample_order", Guid.NewGuid());

            var line1 = TestTree.Row("sample_orderline", Guid.NewGuid(),
                ("line_orderid", new EntityReference("sample_order", order1.Id)),
                ("amt", new Money(10m)));
            var line2 = TestTree.Row("sample_orderline", Guid.NewGuid(),
                ("line_orderid", new EntityReference("sample_order", order2.Id)),
                ("amt", new Money(25m)));

            var shipment1 = TestTree.Row("sample_shipment", Guid.NewGuid(),
                ("shipment_orderid", new EntityReference("sample_order", order1.Id)),
                ("statuscode", "expedited"));

            var cache = TestTree.Cache(
                (orderId, new List<Entity> { order1, order2 }),
                (lineId, new List<Entity> { line1, line2 }),
                (shipmentId, new List<Entity> { shipment1 }));

            var existsSubFilter = new NodeFilterGroup
            {
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion { FieldName = "statuscode", Operator = "eq", Value = "expedited" },
                },
            };
            var existsCriterion = new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = shipmentId,
                MinCount = 1,
                MaxCount = null,
                SubFilter = existsSubFilter,
            };
            var filterGroup = new NodeFilterGroup
            {
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion> { existsCriterion },
            };
            var filters = new Dictionary<string, NodeFilterGroup> { ["f1"] = filterGroup };

            var filterEval = new NodeFilterEvaluator(new FieldValueResolver(), null, cache, configs);
            var root = order1;

            // Only line1's order has a qualifying shipment, so the filtered sum excludes line2.
            Assert.Equal(10m, Eval($"sum(node:{lineId}.amt filter:f1)", root, cache, configs, filters, filterEval));
            // Unfiltered, both lines reduce - proving the filter actually excluded something.
            Assert.Equal(35m, Eval($"sum(node:{lineId}.amt)", root, cache, configs, filters, filterEval));
        }
    }
}
