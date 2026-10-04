using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class QueryExecutorBatchTests
    {
        // order (root) ─┬─ line (child, by sample_orderid) ── note (child, by sample_lineid)
        //               └─ customer (lookup, by sample_customerid → sample_customerid)
        private sealed class Shape
        {
            public TableConfigTree Tree;
            public Guid Root = Guid.NewGuid(), Lines = Guid.NewGuid(), Notes = Guid.NewGuid(), Customer = Guid.NewGuid();
            public QueryExecutionPlan Plan()
            {
                var plan = new QueryExecutionPlan();
                plan.Levels.Add(new List<ExecutionPlanEntry>
                {
                    new ExecutionPlanEntry { Node = Tree.Node(Lines), ParentCacheKey = Root.ToString() },
                    new ExecutionPlanEntry { Node = Tree.Node(Customer), ParentCacheKey = Root.ToString() },
                });
                plan.Levels.Add(new List<ExecutionPlanEntry>
                {
                    new ExecutionPlanEntry { Node = Tree.Node(Notes), ParentCacheKey = Lines.ToString() },
                });
                return plan;
            }
            public ExecutionPlanEntry Entry(QueryExecutionPlan plan, Guid node) =>
                plan.Levels.SelectMany(l => l).Single(e => e.Node.Id == node);
        }

        private static Shape BuildShape()
        {
            var s = new Shape();
            s.Tree = TestTree.Tree(
                new TableConfig { Id = s.Root, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = s.Lines, TableLogicalName = "sample_line", ConfigType = TableConfigType.ChildTable,
                                  ParentTableId = s.Root, ChildLinkField = "sample_orderid" },
                new TableConfig { Id = s.Notes, TableLogicalName = "sample_note", ConfigType = TableConfigType.ChildTable,
                                  ParentTableId = s.Lines, ChildLinkField = "sample_lineid" },
                new TableConfig { Id = s.Customer, TableLogicalName = "sample_customer", ConfigType = TableConfigType.LookupTable,
                                  ParentTableId = s.Root, LookupColumnLogicalName = "sample_customerid",
                                  LookupTargetIdAttribute = "sample_customerid" });
            return s;
        }

        private static Entity Order(Guid customer) => new Entity("sample_order", Guid.NewGuid())
        {
            ["sample_customerid"] = new EntityReference("sample_customer", customer),
            ["createdon"] = new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc),
        };

        private static Entity Line(Entity order, int amount) => new Entity("sample_line", Guid.NewGuid())
        {
            ["sample_orderid"] = order.ToEntityReference(), ["sample_amount"] = amount,
        };

        private static Entity Note(Entity line) => new Entity("sample_note", Guid.NewGuid())
        {
            ["sample_lineid"] = line.ToEntityReference(), ["sample_text"] = "n",
        };

        private static Entity Customer(Guid id) => new Entity("sample_customer", id) { ["sample_name"] = "c" };

        // Every node and variant key the plan stores, per root: sorted "id:attr=value;…" strings.
        private static List<string> Snapshot(QueryResultCache cache, QueryExecutionPlan plan)
        {
            var keys = new List<string>();
            foreach (var entry in plan.Levels.SelectMany(l => l))
            {
                var variants = new[] { (string)null }.Concat((entry.Variants ?? new List<NodeQueryVariant>()).Select(v => v.Key));
                foreach (var key in variants)
                {
                    if (!cache.Has(entry.Node.Id, key)) { keys.Add($"{entry.Node.Id}|{key}|absent"); continue; }
                    foreach (var row in cache.Get(entry.Node.Id, key))
                        keys.Add($"{entry.Node.Id}|{key}|{row.Id}|" + string.Join(";", row.Attributes.OrderBy(a => a.Key)
                            .Select(a => a.Key + "=" + (a.Value is EntityReference r ? r.Id.ToString() : Convert.ToString(a.Value)))));
                }
            }
            keys.Sort(StringComparer.Ordinal);
            return keys;
        }

        // ExecuteMany over all roots must store, per root, exactly what a group of one stores.
        private static void AssertEquivalent(Shape shape, Func<QueryExecutionPlan> plan, InMemoryFetchService data,
            IList<Entity> roots, InFlightBatch inFlight = null)
        {
            var batchPlan = plan();
            var batched = new QueryExecutor(data, new QueryResultCache(shape.Tree), shape.Tree).ExecuteMany(roots, batchPlan, inFlight);
            Assert.Equal(roots.Count, batched.Count);
            for (var i = 0; i < roots.Count; i++)
            {
                var singlePlan = plan();
                var single = new QueryResultCache(shape.Tree);
                new QueryExecutor(data, single, shape.Tree).Execute(roots[i], singlePlan, inFlight);
                Assert.Equal(Snapshot(single, singlePlan), Snapshot(batched[i], batchPlan));
            }
        }

        [Fact]
        public void Children_lookups_and_grandchildren_match_one_root_at_a_time()
        {
            var shape = BuildShape();
            var c1 = Guid.NewGuid(); var c2 = Guid.NewGuid();
            var a = Order(c1); var b = Order(c2); var empty = new Entity("sample_order", Guid.NewGuid());
            var la = Line(a, 1); var lb1 = Line(b, 2); var lb2 = Line(b, 3);
            var data = new InMemoryFetchService().Add(Customer(c1), Customer(c2), la, lb1, lb2, Note(la), Note(lb2));
            AssertEquivalent(shape, shape.Plan, data, new[] { a, b, empty });
        }

        [Fact]
        public void Roots_sharing_a_lookup_target_each_get_it()
        {
            var shape = BuildShape();
            var c = Guid.NewGuid();
            var a = Order(c); var b = Order(c);
            var data = new InMemoryFetchService().Add(Customer(c));
            var caches = new QueryExecutor(data, new QueryResultCache(shape.Tree), shape.Tree).ExecuteMany(new[] { a, b }, shape.Plan(), null);
            Assert.Single(caches[0].Get(shape.Customer));
            Assert.Single(caches[1].Get(shape.Customer));
            Assert.Equal(1, data.Count("sample_customer"));
        }

        [Fact]
        public void Children_of_a_shared_parent_go_to_every_root_that_reaches_it()
        {
            // Two roots whose line nodes resolve to the same parent (a line under a shared order is
            // modelled by giving both roots the same id): both must receive the line's notes.
            var shape = BuildShape();
            var c = Guid.NewGuid();
            var a = Order(c); var b = new Entity("sample_order", a.Id) { ["sample_customerid"] = new EntityReference("sample_customer", c) };
            var line = Line(a, 1);
            var data = new InMemoryFetchService().Add(Customer(c), line, Note(line));
            var caches = new QueryExecutor(data, new QueryResultCache(shape.Tree), shape.Tree).ExecuteMany(new[] { a, b }, shape.Plan(), null);
            Assert.Single(caches[0].Get(shape.Notes));
            Assert.Single(caches[1].Get(shape.Notes));
        }

        [Fact]
        public void A_group_fetches_each_node_once()
        {
            var shape = BuildShape();
            var roots = Enumerable.Range(0, 25).Select(_ => Order(Guid.NewGuid())).ToList();
            var data = new InMemoryFetchService();
            foreach (var r in roots) data.Add(Customer(r.GetAttributeValue<EntityReference>("sample_customerid").Id), Line(r, 1));
            new QueryExecutor(data, new QueryResultCache(shape.Tree), shape.Tree).ExecuteMany(roots, shape.Plan(), null);
            Assert.Equal(1, data.Count("sample_line"));
            Assert.Equal(1, data.Count("sample_customer"));
            Assert.Equal(1, data.Count("sample_note"));
        }

        [Fact]
        public void A_group_of_one_issues_exactly_the_fetches_execute_issues()
        {
            var shape = BuildShape();
            var c = Guid.NewGuid(); var a = Order(c); var line = Line(a, 1);
            var data1 = new InMemoryFetchService().Add(Customer(c), line);
            var data2 = new InMemoryFetchService().Add(Customer(c), line);
            new QueryExecutor(data1, new QueryResultCache(shape.Tree), shape.Tree).Execute(a, shape.Plan());
            new QueryExecutor(data2, new QueryResultCache(shape.Tree), shape.Tree).ExecuteMany(new[] { a }, shape.Plan(), null);
            Assert.Equal(data1.Fetches, data2.Fetches);
        }

        [Fact]
        public void A_fixed_filter_variant_matches_and_is_fetched_once()
        {
            var shape = BuildShape();
            Func<QueryExecutionPlan> plan = () =>
            {
                var p = shape.Plan();
                shape.Entry(p, shape.Lines).Variants.Add(new NodeQueryVariant { Key = "big",
                    FilterFetchXml = "<filter><condition attribute='sample_amount' operator='gt' value='1' /></filter>" });
                return p;
            };
            var c = Guid.NewGuid(); var a = Order(c); var b = Order(c);
            var data = new InMemoryFetchService().Add(Customer(c), Line(a, 1), Line(b, 5));
            AssertEquivalent(shape, plan, data, new[] { a, b });
            data.Fetches.Clear();
            new QueryExecutor(data, new QueryResultCache(shape.Tree), shape.Tree).ExecuteMany(new[] { a, b }, plan(), null);
            Assert.Equal(1, data.Fetches.Count(x => x.Contains("name='sample_line'") && x.Contains("operator='gt'")));
        }

        private static NodeQueryVariant BoundVariant(Guid anchorNodeId, int days)
        {
            var payload = "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + anchorNodeId + "\",\"column\":\"createdon\"},"
                        + "\"op\":\"add\",\"amount\":" + days + ",\"unit\":\"days\"}";
            var filter = new PushedFilter();
            filter.Conditions.Add(new PushedCondition { Attribute = "createdon", Operator = "gt", Binding = new DateBinding(payload, "gt", null, null) });
            return new NodeQueryVariant { Key = filter.CanonicalKey(), Filter = filter };
        }

        [Fact]
        public void Date_bound_variants_share_a_fetch_only_when_their_bindings_are_equal()
        {
            var shape = BuildShape();
            Func<QueryExecutionPlan> plan = () =>
            {
                var p = shape.Plan();
                shape.Entry(p, shape.Lines).Variants.Add(BoundVariant(shape.Root, 30));
                return p;
            };
            var c = Guid.NewGuid();
            var a = Order(c); var b = Order(c); var later = Order(c);
            later["createdon"] = new DateTime(2026, 9, 20, 0, 0, 0, DateTimeKind.Utc);
            var data = new InMemoryFetchService().Add(Customer(c), Line(a, 1), Line(b, 2), Line(later, 3));
            AssertEquivalent(shape, plan, data, new[] { a, b, later });
            data.Fetches.Clear();
            new QueryExecutor(data, new QueryResultCache(shape.Tree), shape.Tree).ExecuteMany(new[] { a, b, later }, plan(), null);
            Assert.Equal(2, data.Fetches.Count(x => x.Contains("name='sample_line'") && x.Contains("attribute='createdon'")));
        }

        [Fact]
        public void In_flight_move_between_roots()
        {
            // The save moves line L from order A to order B: A's lines lose it, B's gain it, as with one
            // root at a time.
            var shape = BuildShape();
            var c = Guid.NewGuid(); var a = Order(c); var b = Order(c);
            var line = Line(a, 7);
            var data = new InMemoryFetchService().Add(Customer(c), line, Line(b, 1));
            var target = new Entity("sample_line", line.Id) { ["sample_orderid"] = b.ToEntityReference() };
            var root = new Entity("sample_line", line.Id) { ["sample_orderid"] = b.ToEntityReference(), ["sample_amount"] = 7 };
            var batch = new InFlightBatch { LogicalName = "sample_line", Operation = InFlightOperation.Update };
            batch.Records.Add(new InFlightRecord { Id = line.Id, Target = target, Root = root });
            AssertEquivalent(shape, shape.Plan, data, new[] { a, b }, batch);
        }

        [Fact]
        public void A_group_whose_total_exceeds_the_cap_but_no_root_does_is_fine()
        {
            var shape = BuildShape();
            var c = Guid.NewGuid();
            var roots = Enumerable.Range(0, 3).Select(_ => Order(c)).ToList();
            var data = new InMemoryFetchService().Add(Customer(c));
            foreach (var r in roots)
                for (var i = 0; i < QueryExecutor.MaxReturnedRowsPerVariant / 2 + 1; i++) data.Add(Line(r, i));
            var caches = new QueryExecutor(data, new QueryResultCache(shape.Tree), shape.Tree).ExecuteMany(roots, shape.Plan(), null);
            Assert.All(caches, cache => Assert.Equal(QueryExecutor.MaxReturnedRowsPerVariant / 2 + 1, cache.Get(shape.Lines).Count));
        }

        [Fact]
        public void One_root_over_the_cap_still_fails_the_group()
        {
            var shape = BuildShape();
            var c = Guid.NewGuid(); var small = Order(c); var big = Order(c);
            var data = new InMemoryFetchService().Add(Customer(c), Line(small, 1));
            for (var i = 0; i <= QueryExecutor.MaxReturnedRowsPerVariant; i++) data.Add(Line(big, i));
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                new QueryExecutor(data, new QueryResultCache(shape.Tree), shape.Tree).ExecuteMany(new[] { small, big }, shape.Plan(), null));
            Assert.Contains("needed more than 25,000 matching rows from 'sample_line'", ex.Message);
        }
    }
}
