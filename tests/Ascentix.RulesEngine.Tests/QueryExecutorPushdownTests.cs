using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// QueryExecutor pushdown mechanics: variant fetches carry the pushed filter,
    /// results land under (nodeId, variantKey), the unfiltered fetch is skipped when the planner
    /// cleared DemandsUnfiltered, and the traversal cap counts rows RETURNED, failing with the
    /// named error, never truncating.
    /// </summary>
    public class QueryExecutorPushdownTests
    {
        private class FakeService : IOrganizationService
        {
            public List<string> Fetches = new List<string>();
            public Func<string, int, EntityCollection> OnFetch; // (fetchXml, callIndex) -> page

            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                var xml = ((FetchExpression)query).Query;
                Fetches.Add(xml);
                return OnFetch(xml, Fetches.Count - 1);
            }

            public Guid Create(Entity entity) => throw new NotSupportedException();
            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => throw new NotSupportedException();
            public void Update(Entity entity) => throw new NotSupportedException();
            public void Delete(string entityName, Guid id) => throw new NotSupportedException();
            public OrganizationResponse Execute(OrganizationRequest request) => throw new NotSupportedException();
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
        }

        private static EntityCollection Page(string table, int count, bool more = false, string cookie = null)
        {
            var col = new EntityCollection { MoreRecords = more, PagingCookie = cookie };
            for (var i = 0; i < count; i++) col.Entities.Add(new Entity(table, Guid.NewGuid()));
            return col;
        }

        private static (TableConfigTree configs, QueryExecutionPlan plan, ExecutionPlanEntry entry, Entity root)
            ChildSetup()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable },
                new TableConfig
                {
                    Id = childId,
                    TableLogicalName = "contact",
                    ConfigType = TableConfigType.ChildTable,
                    ChildLinkField = "parentcustomerid",
                    ParentTableId = rootId,
                }
            );
            var entry = new ExecutionPlanEntry { Node = configs.Node(childId), ParentCacheKey = rootId.ToString() };
            var plan = new QueryExecutionPlan();
            plan.Levels.Add(new List<ExecutionPlanEntry> { entry });
            return (configs, plan, entry, new Entity("account", Guid.NewGuid()));
        }

        [Fact]
        public void Variant_fetch_carries_pushed_filter_and_stores_under_variant_key()
        {
            var (configs, plan, entry, root) = ChildSetup();
            entry.Variants.Add(new NodeQueryVariant
            {
                Key = "and(c[statuscode|eq|1])",
                FilterFetchXml = "<filter type='and'><condition attribute='statuscode' operator='eq' value='1' /></filter>",
            });

            var svc = new FakeService
            {
                OnFetch = (xml, i) => Page("contact", xml.Contains("statuscode") ? 2 : 5),
            };
            var cache = new QueryResultCache();
            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            Assert.Equal(2, svc.Fetches.Count); // unfiltered + one variant
            Assert.DoesNotContain("statuscode", svc.Fetches[0]);
            Assert.Contains("<condition attribute='statuscode' operator='eq' value='1' />", svc.Fetches[1]);

            Assert.Equal(5, cache.Get(entry.Node.Id).Count);
            Assert.Equal(2, cache.Get(entry.Node.Id, "and(c[statuscode|eq|1])").Count);
        }

        [Fact]
        public void Unfiltered_fetch_is_skipped_when_not_demanded()
        {
            var (configs, plan, entry, root) = ChildSetup();
            entry.DemandsUnfiltered = false;
            entry.Variants.Add(new NodeQueryVariant { Key = "k", FilterFetchXml = "<filter type='and'><condition attribute='a' operator='eq' value='1' /></filter>" });

            var svc = new FakeService { OnFetch = (xml, i) => Page("contact", 3) };
            var cache = new QueryResultCache();
            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            // The one fetch that ran was the variant; a 3M-row collection is never materialized.
            Assert.Single(svc.Fetches);
            Assert.Contains("attribute='a'", svc.Fetches[0]);
            Assert.False(cache.Has(entry.Node.Id));
            Assert.True(cache.Has(entry.Node.Id, "k"));
        }

        [Fact]
        public void Cap_counts_returned_rows_and_fails_with_named_error()
        {
            var (configs, plan, entry, root) = ChildSetup();
            var svc = new FakeService
            {
                // 5k pages forever: an unfiltered fetch of a huge collection.
                OnFetch = (xml, i) => Page("contact", 5000, more: true, cookie: "c"),
            };
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => new QueryExecutor(svc, new QueryResultCache(), configs).Execute(root, plan));

            Assert.Contains("25,000", ex.Message);
            Assert.Contains("contact", ex.Message);
            Assert.Contains("account", ex.Message);
            Assert.Contains(entry.Node.Id.ToString(), ex.Message);
            // Failed before fetching the whole collection: exactly cap/page + 1 pages.
            Assert.Equal(6, svc.Fetches.Count);
        }

        [Fact]
        public void Exactly_cap_rows_passes()
        {
            var (configs, plan, entry, root) = ChildSetup();
            var pages = 0;
            var svc = new FakeService
            {
                OnFetch = (xml, i) =>
                {
                    pages++;
                    return Page("contact", 5000, more: pages < 5, cookie: "c");
                },
            };
            var cache = new QueryResultCache();
            new QueryExecutor(svc, cache, configs).Execute(root, plan);
            Assert.Equal(QueryExecutor.MaxReturnedRowsPerVariant, cache.Get(entry.Node.Id).Count);
        }

        [Fact]
        public void Lookup_variant_fetch_carries_pushed_filter()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig
                {
                    Id = lookupId,
                    TableLogicalName = "sample_customer",
                    ConfigType = TableConfigType.LookupTable,
                    LookupColumnLogicalName = "sample_customerid",
                    LookupTargetIdAttribute = "sample_customerid",
                    ParentTableId = rootId,
                }
            );
            var entry = new ExecutionPlanEntry { Node = configs.Node(lookupId), ParentCacheKey = rootId.ToString() };
            entry.Variants.Add(new NodeQueryVariant { Key = "k", FilterFetchXml = "<filter type='and'><condition attribute='sample_region' operator='eq' value='West' /></filter>" });
            var plan = new QueryExecutionPlan();
            plan.Levels.Add(new List<ExecutionPlanEntry> { entry });

            var root = new Entity("sample_order", Guid.NewGuid());
            root["sample_customerid"] = new EntityReference("sample_customer", Guid.NewGuid());

            var svc = new FakeService { OnFetch = (xml, i) => Page("sample_customer", 1) };
            var cache = new QueryResultCache();
            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            Assert.Equal(2, svc.Fetches.Count);
            Assert.Contains("sample_region", svc.Fetches[1]);
            Assert.True(cache.Has(lookupId));
            Assert.True(cache.Has(lookupId, "k"));
        }

        [Fact]
        public void Empty_parent_set_stores_empty_variants_without_fetching()
        {
            var (configs, plan, entry, root) = ChildSetup();
            // Reparent the child to a node whose fetch ran and matched nothing. (A parent the
            // planner never fetched is a different fact: the executor's parent read throws for
            // it rather than scoping the child to an empty set; see QueryResultCacheTests.)
            var emptyParent = Guid.NewGuid();
            entry.ParentCacheKey = emptyParent.ToString();
            entry.Variants.Add(new NodeQueryVariant { Key = "k", FilterFetchXml = "<filter type='and' />" });

            var svc = new FakeService { OnFetch = (xml, i) => throw new Exception("must not fetch") };
            var cache = new QueryResultCache();
            cache.Store(emptyParent, new List<Entity>());
            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            Assert.Empty(svc.Fetches);
            Assert.True(cache.Has(entry.Node.Id));
            Assert.True(cache.Has(entry.Node.Id, "k"));
            Assert.Empty(cache.Get(entry.Node.Id, "k"));
        }
    }
}
