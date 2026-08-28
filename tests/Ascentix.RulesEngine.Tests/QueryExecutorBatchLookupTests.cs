using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class QueryExecutorBatchLookupTests
    {
        // root -> lookup(perf_lookup1). One parent with a lookup ref.
        private static (TableConfigTree configs, Guid rootId, Guid lookupId) BuildTree(string targetIdAttr)
        {
            var rootCfg = Guid.NewGuid();
            var lookupCfg = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootCfg, TableLogicalName = "perf_root", ConfigType = TableConfigType.RootTable },
                new TableConfig
                {
                    Id = lookupCfg, TableLogicalName = "perf_lookup1", ConfigType = TableConfigType.LookupTable,
                    ParentTableId = rootCfg,
                    LookupColumnLogicalName = "perf_lookup1id",
                    LookupTargetIdAttribute = targetIdAttr,
                });
            return (configs, rootCfg, lookupCfg);
        }

        [Fact]
        public void Lookup_uses_one_RetrieveMultiple_not_per_parent_Retrieve()
        {
            var (configs, rootCfg, lookupCfg) = BuildTree("perf_lookup1id");
            var targetId = Guid.NewGuid();
            var root = new Entity("perf_root", Guid.NewGuid())
            {
                ["perf_lookup1id"] = new EntityReference("perf_lookup1", targetId)
            };
            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition>(), new HashSet<Guid> { lookupCfg });

            var target = new EntityCollection { EntityName = "perf_lookup1" };
            target.Entities.Add(new Entity("perf_lookup1", targetId));
            var svc = new RecordingFakeService(new[] { target });
            var cache = new QueryResultCache();

            new QueryExecutor(svc, cache, configs, new RunDiagnostics()).Execute(root, plan);

            Assert.Equal(1, svc.RetrieveMultipleCount);
            Assert.Equal(0, svc.RetrieveCount);
            Assert.Single(cache.Get(lookupCfg));
            Assert.Equal(targetId, cache.Get(lookupCfg)[0].Id);
        }

        [Fact]
        public void Lookup_missing_target_id_attribute_throws()
        {
            var (configs, rootCfg, lookupCfg) = BuildTree(null); // blank → enforced
            var root = new Entity("perf_root", Guid.NewGuid())
            {
                ["perf_lookup1id"] = new EntityReference("perf_lookup1", Guid.NewGuid())
            };
            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition>(), new HashSet<Guid> { lookupCfg });
            var svc = new RecordingFakeService(new EntityCollection[0]);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                new QueryExecutor(svc, new QueryResultCache(), configs).Execute(root, plan));
            Assert.Contains("lookuptargetidattribute", ex.Message);
        }

        [Fact]
        public void Lookup_dedupes_target_ids_in_the_IN_query()
        {
            // root -> child(2 rows, same lookup target) -> lookup off child.
            var rootCfg = Guid.NewGuid();
            var childCfg = Guid.NewGuid();
            var lookupCfg = Guid.NewGuid();
            var sharedTarget = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootCfg, TableLogicalName = "perf_root", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = childCfg, TableLogicalName = "perf_child1", ConfigType = TableConfigType.ChildTable, ParentTableId = rootCfg, ChildLinkField = "perf_rootid" },
                new TableConfig { Id = lookupCfg, TableLogicalName = "perf_lookup1", ConfigType = TableConfigType.LookupTable, ParentTableId = childCfg, LookupColumnLogicalName = "perf_child1lookupid", LookupTargetIdAttribute = "perf_lookup1id" });
            var root = new Entity("perf_root", Guid.NewGuid());
            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition>(), new HashSet<Guid> { childCfg, lookupCfg });

            // Page 1: the child query returns 2 child rows both pointing at sharedTarget.
            var childPage = new EntityCollection { EntityName = "perf_child1" };
            for (var i = 0; i < 2; i++)
                childPage.Entities.Add(new Entity("perf_child1", Guid.NewGuid()) { ["perf_child1lookupid"] = new EntityReference("perf_lookup1", sharedTarget) });
            // Then the lookup query returns the single distinct target.
            var lookupPage = new EntityCollection { EntityName = "perf_lookup1" };
            lookupPage.Entities.Add(new Entity("perf_lookup1", sharedTarget));

            var svc = new RecordingFakeService(new[] { childPage, lookupPage });
            new QueryExecutor(svc, new QueryResultCache(), configs).Execute(root, plan);

            // 2 RetrieveMultiple total (1 child + 1 lookup); the lookup fetch has exactly ONE <value>.
            Assert.Equal(2, svc.RetrieveMultipleCount);
            var lookupFetch = svc.CapturedFetchXml.Last();
            Assert.Equal(1, System.Text.RegularExpressions.Regex.Matches(lookupFetch, "<value>").Count);
        }
    }
}
