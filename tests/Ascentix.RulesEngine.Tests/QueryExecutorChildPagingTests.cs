using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class QueryExecutorChildPagingTests
    {
        // root -> child(perf_child1)
        private static (TableConfigTree configs, Guid childId) BuildTree()
        {
            var rootCfg = Guid.NewGuid();
            var childCfg = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootCfg, TableLogicalName = "perf_root", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = childCfg, TableLogicalName = "perf_child1", ConfigType = TableConfigType.ChildTable, ParentTableId = rootCfg, ChildLinkField = "perf_rootid" });
            return (configs, childCfg);
        }

        [Fact]
        public void Child_query_pages_until_no_more_records()
        {
            var (configs, childCfg) = BuildTree();
            var root = new Entity("perf_root", Guid.NewGuid());
            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition>(), new HashSet<Guid> { childCfg });

            // Two pages: first MoreRecords=true (3 rows), second false (2 rows) => 5 total.
            var svc = new RecordingFakeService(new[]
            {
                FakePages.Page("perf_child1", 3, moreRecords: true),
                FakePages.Page("perf_child1", 2, moreRecords: false),
            });
            var cache = new QueryResultCache();

            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            Assert.Equal(2, svc.RetrieveMultipleCount);   // both pages fetched
            Assert.Equal(5, cache.Get(childCfg).Count);   // all rows accumulated
        }

        [Fact]
        public void Child_query_chunks_large_parent_id_lists()
        {
            // 2500 parents (>1 chunk of 2000) seeded into the child's parent node cache via a
            // lookup-free path: make the ROOT node itself carry 2500 ids by seeding the parent
            // node directly through a ChildTable whose parent is root with 2500 root-side rows.
            // Simpler: seed parentResults by giving the child node a parent node pre-filled.
            var rootCfg = Guid.NewGuid();
            var midCfg = Guid.NewGuid();   // a child of root, holds 2500 rows = parents of the leaf
            var leafCfg = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootCfg, TableLogicalName = "perf_root", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = midCfg, TableLogicalName = "perf_child1", ConfigType = TableConfigType.ChildTable, ParentTableId = rootCfg, ChildLinkField = "perf_rootid" },
                new TableConfig { Id = leafCfg, TableLogicalName = "perf_child2", ConfigType = TableConfigType.ChildTable, ParentTableId = midCfg, ChildLinkField = "perf_child1id" });
            var root = new Entity("perf_root", Guid.NewGuid());
            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition>(), new HashSet<Guid> { midCfg, leafCfg });

            // mid query returns 2500 rows (1 page); leaf query then runs in 2 chunks (2000 + 500),
            // each a single page. Queue: [mid page, leaf chunk1 page, leaf chunk2 page].
            var svc = new RecordingFakeService(new[]
            {
                FakePages.Page("perf_child1", 2500, moreRecords: false),
                FakePages.Page("perf_child2", 10, moreRecords: false),
                FakePages.Page("perf_child2", 5, moreRecords: false),
            });
            var cache = new QueryResultCache();

            new QueryExecutor(svc, cache, configs).Execute(root, plan);

            // 1 (mid) + 2 (leaf chunks) = 3 RetrieveMultiple calls; leaf accumulates both chunks.
            Assert.Equal(3, svc.RetrieveMultipleCount);
            Assert.Equal(15, cache.Get(leafCfg).Count);
        }
    }
}
