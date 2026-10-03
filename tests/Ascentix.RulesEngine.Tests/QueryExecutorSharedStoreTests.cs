using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class QueryExecutorSharedStoreTests
    {
        private static readonly Guid OrderId = Guid.NewGuid();

        private sealed class FakeService : IOrganizationService
        {
            public Func<string, EntityCollection> OnFetch;
            public readonly List<string> Fetches = new List<string>();
            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                var xml = ((FetchExpression)query).Query;
                Fetches.Add(xml);
                return OnFetch(xml);
            }
            public Guid Create(Entity entity) => throw new NotSupportedException();
            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => throw new NotSupportedException();
            public void Update(Entity entity) => throw new NotSupportedException();
            public void Delete(string entityName, Guid id) => throw new NotSupportedException();
            public OrganizationResponse Execute(OrganizationRequest request) => throw new NotSupportedException();
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
        }

        // root sample_order → child sample_orderline (by sample_orderid)
        //                    → lookup sample_customer (by sample_customerid)
        private sealed class Shape
        {
            public TableConfigTree Tree;
            public Guid RootId, LinesId, CustomerId;
            public QueryExecutionPlan Plan(HashSet<string> lineColumns = null)
            {
                var plan = new QueryExecutionPlan();
                plan.Levels.Add(new List<ExecutionPlanEntry>
                {
                    new ExecutionPlanEntry { Node = Tree.Node(LinesId), ParentCacheKey = RootId.ToString(), Columns = lineColumns },
                    new ExecutionPlanEntry { Node = Tree.Node(CustomerId), ParentCacheKey = RootId.ToString() },
                });
                return plan;
            }
        }

        private static Shape BuildShape()
        {
            var s = new Shape { RootId = Guid.NewGuid(), LinesId = Guid.NewGuid(), CustomerId = Guid.NewGuid() };
            s.Tree = TestTree.Tree(
                new TableConfig { Id = s.RootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig
                {
                    Id = s.LinesId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable,
                    ParentTableId = s.RootId, ChildLinkField = "sample_orderid",
                },
                new TableConfig
                {
                    Id = s.CustomerId, TableLogicalName = "sample_customer", ConfigType = TableConfigType.LookupTable,
                    ParentTableId = s.RootId, LookupColumnLogicalName = "sample_customerid", LookupTargetIdAttribute = "sample_customerid",
                });
            return s;
        }

        private static Entity Root(Guid customer) => new Entity("sample_order", OrderId)
        {
            ["sample_customerid"] = new EntityReference("sample_customer", customer),
        };

        private static EntityCollection Rows(string table, int count, bool more = false, string cookie = "<cookie/>")
        {
            var c = new EntityCollection { MoreRecords = more };
            if (more) c.PagingCookie = cookie;
            for (var i = 0; i < count; i++)
                c.Entities.Add(new Entity(table, Guid.NewGuid())
                {
                    ["sample_orderid"] = new EntityReference("sample_order", OrderId),
                    ["sample_amount"] = 1m,
                });
            return c;
        }

        private static FakeService Service() => new FakeService
        {
            OnFetch = xml => xml.Contains("name='sample_customer'")
                ? new EntityCollection(new List<Entity> { new Entity("sample_customer", Guid.NewGuid()) })
                : Rows("sample_orderline", 3)
        };

        private static int Count(FakeService s, string table) => s.Fetches.Count(x => x.Contains($"name='{table}'"));

        [Fact]
        public void Two_buckets_fetch_the_same_child_and_lookup_once()
        {
            var shape = BuildShape();
            var service = Service();
            var store = new RunFetchStore(new RunDiagnostics());
            var customer = Guid.NewGuid();

            var a = new QueryResultCache(shape.Tree);
            new QueryExecutor(service, a, shape.Tree, store: store).Execute(Root(customer), shape.Plan());
            var b = new QueryResultCache(shape.Tree);
            new QueryExecutor(service, b, shape.Tree, store: store).Execute(Root(customer), shape.Plan());

            Assert.Equal(1, Count(service, "sample_orderline"));
            Assert.Equal(1, Count(service, "sample_customer"));
            Assert.Equal(3, b.Get(shape.LinesId).Count);
            Assert.NotSame(a.Get(shape.LinesId), b.Get(shape.LinesId));
        }

        [Fact]
        public void Without_a_store_every_executor_fetches_as_before()
        {
            var shape = BuildShape();
            var service = Service();
            var customer = Guid.NewGuid();
            new QueryExecutor(service, new QueryResultCache(shape.Tree), shape.Tree).Execute(Root(customer), shape.Plan());
            new QueryExecutor(service, new QueryResultCache(shape.Tree), shape.Tree).Execute(Root(customer), shape.Plan());
            Assert.Equal(2, Count(service, "sample_orderline"));
        }

        [Fact]
        public void Child_fetch_requests_the_combined_columns()
        {
            var shape = BuildShape();
            var service = Service();
            var store = new RunFetchStore();
            var mine = new HashSet<string>(new[] { "sample_amount" }, StringComparer.OrdinalIgnoreCase);
            var other = new HashSet<string>(new[] { "sample_qty" }, StringComparer.OrdinalIgnoreCase);
            store.DemandColumns(service, shape.Tree.Node(shape.LinesId), mine);
            store.DemandColumns(service, shape.Tree.Node(shape.LinesId), other);

            new QueryExecutor(service, new QueryResultCache(shape.Tree), shape.Tree, store: store)
                .Execute(Root(Guid.NewGuid()), shape.Plan(mine));
            new QueryExecutor(service, new QueryResultCache(shape.Tree), shape.Tree, store: store)
                .Execute(Root(Guid.NewGuid()), shape.Plan(other));

            var lineFetch = Assert.Single(service.Fetches, x => x.Contains("name='sample_orderline'"));
            Assert.Contains("<attribute name='sample_amount' />", lineFetch);
            Assert.Contains("<attribute name='sample_qty' />", lineFetch);
        }

        [Fact]
        public void One_buckets_in_flight_overlay_does_not_reach_another_bucket()
        {
            var shape = BuildShape();
            var lineId = Guid.NewGuid();
            var service = new FakeService
            {
                OnFetch = xml => xml.Contains("name='sample_customer'")
                    ? new EntityCollection()
                    : new EntityCollection(new List<Entity>
                    {
                        new Entity("sample_orderline", lineId)
                        {
                            ["sample_orderid"] = new EntityReference("sample_order", OrderId), ["sample_amount"] = 1m,
                        }
                    })
            };
            var store = new RunFetchStore();
            var target = new Entity("sample_orderline", lineId) { ["sample_amount"] = 9m };
            var batch = new InFlightBatch { LogicalName = "sample_orderline", Operation = InFlightOperation.Update };
            batch.Records.Add(new InFlightRecord { Id = lineId, Target = target, Root = target });

            var a = new QueryResultCache(shape.Tree);
            new QueryExecutor(service, a, shape.Tree, store: store).Execute(Root(Guid.NewGuid()), shape.Plan(), batch);
            var b = new QueryResultCache(shape.Tree);
            new QueryExecutor(service, b, shape.Tree, store: store).Execute(Root(Guid.NewGuid()), shape.Plan());

            Assert.Equal(9m, a.Get(shape.LinesId).Single()["sample_amount"]);
            Assert.Equal(1m, b.Get(shape.LinesId).Single()["sample_amount"]);
        }

        [Fact]
        public void Previous_parent_root_shares_root_collections()
        {
            var shape = BuildShape();
            var service = Service();
            var store = new RunFetchStore();
            var current = Root(Guid.NewGuid());
            var previous = Root(Guid.NewGuid()); // same order id, other customer: what PreviousParent.RootFor builds

            new QueryExecutor(service, new QueryResultCache(shape.Tree), shape.Tree, store: store).Execute(current, shape.Plan());
            new QueryExecutor(service, new QueryResultCache(shape.Tree), shape.Tree, store: store).Execute(previous, shape.Plan());

            Assert.Equal(1, Count(service, "sample_orderline"));
            Assert.Equal(2, Count(service, "sample_customer"));
        }

        [Fact]
        public void Paged_child_fetch_is_stored_whole_and_shared()
        {
            var shape = BuildShape();
            var page = 0;
            var service = new FakeService
            {
                OnFetch = xml => xml.Contains("name='sample_customer'")
                    ? new EntityCollection()
                    : (++page == 1 ? Rows("sample_orderline", 5000, more: true) : Rows("sample_orderline", 2))
            };
            var store = new RunFetchStore();
            var a = new QueryResultCache(shape.Tree);
            new QueryExecutor(service, a, shape.Tree, store: store).Execute(Root(Guid.NewGuid()), shape.Plan());
            var b = new QueryResultCache(shape.Tree);
            new QueryExecutor(service, b, shape.Tree, store: store).Execute(Root(Guid.NewGuid()), shape.Plan());

            Assert.Equal(2, Count(service, "sample_orderline"));
            Assert.Equal(5002, b.Get(shape.LinesId).Count);
        }

        [Fact]
        public void Cap_error_still_throws_and_nothing_is_stored()
        {
            var shape = BuildShape();
            var service = new FakeService
            {
                OnFetch = xml => xml.Contains("name='sample_customer'")
                    ? new EntityCollection()
                    : Rows("sample_orderline", QueryExecutor.MaxReturnedRowsPerVariant + 1)
            };
            var store = new RunFetchStore();
            Assert.Throws<InvalidPluginExecutionException>(() =>
                new QueryExecutor(service, new QueryResultCache(shape.Tree), shape.Tree, store: store)
                    .Execute(Root(Guid.NewGuid()), shape.Plan()));
            Assert.Throws<InvalidPluginExecutionException>(() =>
                new QueryExecutor(service, new QueryResultCache(shape.Tree), shape.Tree, store: store)
                    .Execute(Root(Guid.NewGuid()), shape.Plan()));
            Assert.Equal(2, Count(service, "sample_orderline"));
        }

        [Fact]
        public void Empty_scope_never_reaches_the_store()
        {
            var shape = BuildShape();
            var service = Service();
            var store = new RunFetchStore();
            var noCustomer = new Entity("sample_order", OrderId);
            var cache = new QueryResultCache(shape.Tree);
            new QueryExecutor(service, cache, shape.Tree, store: store).Execute(noCustomer, shape.Plan());
            Assert.Equal(0, Count(service, "sample_customer"));
            Assert.Empty(cache.Get(shape.CustomerId));
        }
    }
}
