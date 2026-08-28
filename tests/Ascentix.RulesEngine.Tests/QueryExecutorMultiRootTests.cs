using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Two published rules on the same table may come from two different configuration trees
    /// (two RootTable nodes). The runner loads both trees into one forest and runs one
    /// traversal. QueryExecutor must seed the triggering record into EVERY root: seeding only
    /// the FIRST leaves the other tree's child nodes fetching against an empty parent set, so
    /// every collection-based condition on that tree counts zero, and which tree loses depends
    /// on dictionary order, which surfaces as failures that move between runs.
    /// </summary>
    public class QueryExecutorMultiRootTests
    {
        private static readonly Guid OrderId = Guid.NewGuid();

        private sealed class FakeService : IOrganizationService
        {
            public readonly List<string> Fetches = new List<string>();
            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                Fetches.Add(((FetchExpression)query).Query);
                var col = new EntityCollection();
                col.Entities.Add(Line(Guid.NewGuid()));
                col.Entities.Add(Line(Guid.NewGuid()));
                return col;
            }
            public Guid Create(Entity entity) => throw new NotSupportedException();
            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => throw new NotSupportedException();
            public void Update(Entity entity) => throw new NotSupportedException();
            public void Delete(string entityName, Guid id) => throw new NotSupportedException();
            public OrganizationResponse Execute(OrganizationRequest request) => throw new NotSupportedException();
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
        }

        private static Entity Line(Guid id) => new Entity("sample_orderline", id)
        {
            ["sample_lineamount"] = new Money(10m),
            ["sample_orderid"] = new EntityReference("sample_order", OrderId),
        };

        /// <summary>root sample_order → child sample_orderline; returns (rootId, linesId).</summary>
        private static (Guid root, Guid lines) AddTree(List<TableConfig> nodes)
        {
            var rootId = Guid.NewGuid();
            var linesId = Guid.NewGuid();
            nodes.Add(new TableConfig { Id = rootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable });
            nodes.Add(new TableConfig
            {
                Id = linesId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable,
                ParentTableId = rootId, ChildLinkField = "sample_orderid",
            });
            return (rootId, linesId);
        }

        [Fact]
        public void Every_root_for_the_triggering_table_is_seeded_so_both_trees_see_their_children()
        {
            var nodes = new List<TableConfig>();
            var a = AddTree(nodes);   // inserted first, the only tree the old code seeded
            var b = AddTree(nodes);   // the tree that used to read empty collections
            var tree = TestTree.Tree(nodes.ToArray());

            var plan = new QueryExecutionPlan();
            plan.Levels.Add(new List<ExecutionPlanEntry>
            {
                new ExecutionPlanEntry { Node = tree.Node(a.lines), ParentCacheKey = a.root.ToString() },
                new ExecutionPlanEntry { Node = tree.Node(b.lines), ParentCacheKey = b.root.ToString() },
            });

            var cache = new QueryResultCache();
            var service = new FakeService();
            new QueryExecutor(service, cache, tree).Execute(new Entity("sample_order", OrderId), plan);

            Assert.True(cache.Has(a.root));
            Assert.True(cache.Has(b.root));
            Assert.Equal(2, cache.Get(a.lines).Count);
            Assert.Equal(2, cache.Get(b.lines).Count);   // was 0: parent set empty, no fetch issued
            Assert.Equal(2, service.Fetches.Count);      // one child fetch per tree
        }

        [Fact]
        public void RootColumnCollector_treats_every_root_node_as_the_root()
        {
            var nodes = new List<TableConfig>();
            var a = AddTree(nodes);
            var b = AddTree(nodes);
            var tree = TestTree.Tree(nodes.ToArray());

            var groups = new List<ConditionGroup>
            {
                new ConditionGroup
                {
                    Conditions = new List<RuleCondition>
                    {
                        new RuleCondition { TableConfigNodeId = a.root, ConditionType = ConditionType.FieldComparison, ComparisonColumn = "sample_ordertotal" },
                        new RuleCondition { TableConfigNodeId = b.root, ConditionType = ConditionType.FieldComparison, ComparisonColumn = "sample_status" },
                    },
                },
            };

            var refs = RuleReferences.Compute(groups, null);
            var cols = refs.RootColumns(tree);
            Assert.Contains("sample_ordertotal", cols);
            Assert.Contains("sample_status", cols);        // was missed: b.root was not "the root"
            Assert.True(refs.IsRootOnly(tree));
        }
    }
}
