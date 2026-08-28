using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class MathExprEvaluatorTests
    {
                private static decimal? Eval(string expr, Entity root, QueryResultCache cache = null,
            TableConfigTree configs = null)
        {
            var ast = MathExpr.Parse(expr, "ctx");
            return MathExprEvaluator.TryEvaluate(ast, root, cache ?? new QueryResultCache(),
                configs ?? TableConfigTree.Empty, "ctx", out var r) ? (decimal?)r : null;
        }

        [Fact]
        public void Computes_over_root_columns_and_literals()
        {
            var root = new Entity("sample_orderline") { ["qty"] = 3, ["discount"] = 0.5m };
            Assert.Equal(1.5m, Eval("{root.qty} * (1 - {root.discount})", root));
        }

        [Theory]
        [InlineData(2, "int")]
        [InlineData(2L, "long")]
        public void Widens_integer_operand_types(object raw, string _)
        {
            var root = new Entity("t") { ["n"] = raw };
            Assert.Equal(4m, Eval("{root.n} * 2", root));
        }

        [Fact]
        public void Widens_double_and_money_operands()
        {
            var root = new Entity("t") { ["d"] = 1.5, ["m"] = new Money(4m) };
            Assert.Equal(6m, Eval("{root.d} * {root.m}", root));
        }

        [Fact]
        public void Null_operand_yields_no_value()
        {
            var root = new Entity("t") { ["a"] = 2 }; // b absent => null
            Assert.Null(Eval("{root.a} * {root.b}", root));
        }

        [Fact]
        public void Division_by_zero_yields_no_value()
        {
            var root = new Entity("t") { ["a"] = 10, ["b"] = 0 };
            Assert.Null(Eval("{root.a} / {root.b}", root));
        }

        [Fact]
        public void Reads_related_node_operand_from_cache()
        {
            var rootId = Guid.NewGuid();
            var nodeId = Guid.NewGuid();
            var configs = TestTree.Tree(
                TestTree.Node(rootId, "sample_orderline", TableConfigType.RootTable, null),
                TestTree.Node(nodeId, "sample_product", TableConfigType.LookupTable, rootId));
            var cache = new QueryResultCache();
            cache.Store(nodeId, new List<Entity> { new Entity("sample_product") { ["price"] = 5m } });
            var root = new Entity("sample_orderline") { ["qty"] = 4 };
            Assert.Equal(20m, Eval($"{{root.qty}} * {{node:{nodeId}.price}}", root, cache, configs));
        }

        [Fact]
        public void Non_numeric_operand_throws()
        {
            var root = new Entity("t") { ["s"] = "hello" };
            Assert.Throws<InvalidPluginExecutionException>(() => Eval("{root.s} + 1", root));
        }

        private static (TableConfigTree configs, Guid childId, QueryResultCache cache) ChildSetup(params Entity[] rows)
        {
            var rootId = Guid.NewGuid(); var childId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = childId, TableLogicalName = "sample_orderline",
                    ConfigType = TableConfigType.ChildTable, ParentTableId = rootId }
            );
            var cache = new QueryResultCache();
            cache.Store(childId, new List<Entity>(rows));
            return (configs, childId, cache);
        }

        [Fact]
        public void Sum_and_count_and_avg_over_child_rows()
        {
            var (configs, cid, cache) = ChildSetup(
                new Entity("sample_orderline") { ["amt"] = new Money(10m) },
                new Entity("sample_orderline") { ["amt"] = new Money(30m) });
            var root = new Entity("sample_order");
            Assert.Equal(40m, Eval($"sum(node:{cid}.amt)", root, cache, configs));
            Assert.Equal(2m, Eval($"count(node:{cid})", root, cache, configs));
            Assert.Equal(20m, Eval($"avg(node:{cid}.amt)", root, cache, configs));
            Assert.Equal(10m, Eval($"min(node:{cid}.amt)", root, cache, configs));
            Assert.Equal(30m, Eval($"max(node:{cid}.amt)", root, cache, configs));
        }

        [Fact]
        public void Null_cells_ignored_sum_empty_is_zero_avg_empty_is_no_value()
        {
            var (configs, cid, cache) = ChildSetup(); // zero rows
            var root = new Entity("sample_order");
            Assert.Equal(0m, Eval($"sum(node:{cid}.amt)", root, cache, configs)); // empty sum = 0
            Assert.Equal(0m, Eval($"count(node:{cid})", root, cache, configs));   // empty count = 0
            Assert.Null(Eval($"avg(node:{cid}.amt)", root, cache, configs));      // empty avg = no value
            Assert.Null(Eval($"max(node:{cid}.amt)", root, cache, configs));      // empty max = no value
        }

        [Fact]
        public void Aggregate_node_must_be_a_collection()
        {
            // single-cardinality (lookup) node → aggregate is an author error
            var rootId = Guid.NewGuid(); var lookupId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = lookupId, TableLogicalName = "sample_customer",
                    ConfigType = TableConfigType.LookupTable, ParentTableId = rootId }
            );
            var cache = new QueryResultCache();
            cache.Store(lookupId, new List<Entity> { new Entity("sample_customer") { ["amt"] = new Money(5m) } });
            Assert.Throws<InvalidPluginExecutionException>(() =>
                Eval($"sum(node:{lookupId}.amt)", new Entity("sample_order"), cache, configs));
        }

        [Fact]
        public void Non_numeric_aggregate_column_throws()
        {
            var (configs, cid, cache) = ChildSetup(new Entity("sample_orderline") { ["amt"] = "oops" });
            Assert.Throws<InvalidPluginExecutionException>(() =>
                Eval($"sum(node:{cid}.amt)", new Entity("sample_order"), cache, configs));
        }

        [Fact]
        public void Filter_key_with_a_null_filters_map_throws()
        {
            // ConditionEvaluator calls the back-compat TryEvaluate overload (no filters map),
            // so a filter: term in a condition Expression always throws at runtime.
            // Pins the runtime half; the validation half is fixed below.
            var (configs, cid, cache) = ChildSetup(new Entity("sample_orderline") { ["amt"] = new Money(10m) });
            Assert.Throws<InvalidPluginExecutionException>(() =>
                Eval($"sum(node:{cid}.amt filter:f1)", new Entity("sample_order"), cache, configs));
        }
    }
}
