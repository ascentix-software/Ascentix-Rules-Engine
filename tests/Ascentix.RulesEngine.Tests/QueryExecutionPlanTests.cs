using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// QueryExecutionPlan.Build: every node a condition reads is planned with its full ancestor
    /// chain, never bare (a depth-2 node whose intermediate ancestor nothing else references
    /// would otherwise be planned with an unfetched parent, so its fetch would be scoped to an
    /// empty parent set and the condition would evaluate against zero rows), levels
    /// follow the tree's depth, and a chain that does not reach a Root Table node (cycle,
    /// missing ancestor, parentless non-root) is a planning fault rather than a shorter plan.
    /// </summary>
    public class QueryExecutionPlanTests
    {
        /// <summary>root sample_order → lookup sample_customer → lookup sample_customer (the
        /// customer's parent customer). Only the DEEPEST node is referenced by the rule.</summary>
        private static (TableConfigTree configs, Guid root, Guid customer, Guid parent) LookupChain()
        {
            var rootId = Guid.NewGuid();
            var customerId = Guid.NewGuid();
            var parentId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig
                {
                    Id = rootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable,
                },
                new TableConfig
                {
                    Id = customerId, TableLogicalName = "sample_customer", ConfigType = TableConfigType.LookupTable,
                    ParentTableId = rootId,
                    LookupColumnLogicalName = "sample_customerid", LookupTargetIdAttribute = "sample_customerid",
                },
                new TableConfig
                {
                    Id = parentId, TableLogicalName = "sample_customer", ConfigType = TableConfigType.LookupTable,
                    ParentTableId = customerId,
                    LookupColumnLogicalName = "sample_parentcustomerid", LookupTargetIdAttribute = "sample_customerid",
                });
            return (configs, rootId, customerId, parentId);
        }

        private static RuleCondition FieldComparisonOn(Guid nodeId) => new RuleCondition
        {
            Id = Guid.NewGuid(),
            TableConfigNodeId = nodeId,
            ConditionType = ConditionType.FieldComparison,
            ComparisonColumn = "sample_region",
            ComparisonOperator = ComparisonOperator.Equals,
            ComparisonValue = "West",
            ValueSource = ComparisonValueSource.Literal,
        };

        [Fact]
        public void A_condition_on_a_depth_2_node_plans_its_unreferenced_intermediate_ancestor()
        {
            var (configs, _, customerId, parentId) = LookupChain();

            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition> { FieldComparisonOn(parentId) });

            Assert.Equal(2, plan.Levels.Count);
            var level1 = Assert.Single(plan.Levels[0]);
            Assert.Equal(customerId, level1.Node.Id);          // the hop nothing else referenced
            var level2 = Assert.Single(plan.Levels[1]);
            Assert.Equal(parentId, level2.Node.Id);
            Assert.Equal(customerId.ToString(), level2.ParentCacheKey);
        }

        [Fact]
        public void The_executor_fetches_the_intermediate_ancestor_before_the_condition_node()
        {
            var (configs, _, customerId, parentId) = LookupChain();
            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition> { FieldComparisonOn(parentId) });

            var customerRecordId = Guid.NewGuid();
            var parentRecordId = Guid.NewGuid();
            var customerPage = new EntityCollection();
            customerPage.Entities.Add(new Entity("sample_customer", customerRecordId)
            {
                ["sample_parentcustomerid"] = new EntityReference("sample_customer", parentRecordId),
            });
            var parentPage = new EntityCollection();
            parentPage.Entities.Add(new Entity("sample_customer", parentRecordId) { ["sample_region"] = "West" });
            var service = new RecordingFakeService(new[] { customerPage, parentPage });

            var root = new Entity("sample_order", Guid.NewGuid())
            {
                ["sample_customerid"] = new EntityReference("sample_customer", customerRecordId),
            };
            var cache = new QueryResultCache(configs);
            new QueryExecutor(service, cache, configs).Execute(root, plan);

            Assert.Equal(2, service.RetrieveMultipleCount);
            Assert.Contains(customerRecordId.ToString(), service.CapturedFetchXml[0]);
            Assert.Contains(parentRecordId.ToString(), service.CapturedFetchXml[1]);   // scoped by the fetched hop
            Assert.Equal(customerRecordId, Assert.Single(cache.Get(customerId)).Id);
            Assert.Equal(parentRecordId, Assert.Single(cache.Get(parentId)).Id);
        }

        [Fact]
        public void Plan_build_on_a_cyclic_parent_chain_throws_instead_of_hanging()
        {
            // A -> B -> A (both non-root). The loader refuses this shape, so it is reachable only
            // on an unvalidated tree; the chain diagnosis reports the cycle and the plan throws.
            var a = Guid.NewGuid();
            var b = Guid.NewGuid();
            var nodeA = TestTree.Node(a, "a", TableConfigType.LookupTable, b);
            var nodeB = TestTree.Node(b, "b", TableConfigType.LookupTable, a);
            var configs = TestTree.RawTree(nodeA, nodeB);

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => QueryExecutionPlan.Build(configs, new List<RuleCondition>(), new[] { a }));
            Assert.Contains("cyclic", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        // ─── A chain that does not reach the root is a planning fault, not a shorter plan ──────

        [Fact]
        public void Plan_build_with_a_missing_mid_chain_ancestor_throws_instead_of_silently_truncating()
        {
            // root -> customer -> parent customer, where the customer node failed to load. The
            // walk must not stop at the gap and plan the deepest node with an unfetched parent:
            // the executor would scope its fetch to an empty parent set and every consumer would
            // read zero rows with nothing logged. The plan names the break instead.
            var rootId = Guid.NewGuid();
            var missingCustomerId = Guid.NewGuid();
            var parentId = Guid.NewGuid();
            var tree = TestTree.RawTree(
                TestTree.Node(rootId, "sample_order", TableConfigType.RootTable, null),
                TestTree.Node(parentId, "sample_customer", TableConfigType.LookupTable, missingCustomerId));

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => QueryExecutionPlan.Build(tree, new List<RuleCondition> { FieldComparisonOn(parentId) }));

            Assert.Contains(parentId.ToString(), ex.Message);
            Assert.Contains(missingCustomerId.ToString(), ex.Message);
            Assert.Contains("missing from the rule's config tree", ex.Message);
            Assert.Contains("cannot be planned", ex.Message);
        }

        [Fact]
        public void Plan_build_with_a_parentless_non_root_throws()
        {
            // Only a Root Table node terminates a chain. A lookup with no parent must not be
            // planned as if it hung off the root (its ParentCacheKey null, its fetch reading a
            // parent that does not exist).
            var rootId = Guid.NewGuid();
            var loneId = Guid.NewGuid();
            var tree = TestTree.RawTree(
                TestTree.Node(rootId, "sample_order", TableConfigType.RootTable, null),
                TestTree.Node(loneId, "sample_customer", TableConfigType.LookupTable, null));

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => QueryExecutionPlan.Build(tree, new List<RuleCondition>(), new[] { loneId }));

            Assert.Contains(loneId.ToString(), ex.Message);
            Assert.Contains("does not lead to a Root Table node", ex.Message);
        }

        [Fact]
        public void A_node_id_the_tree_does_not_hold_is_not_planned_and_does_not_throw_here()
        {
            // Unchanged contract: the loader's seed check and the evaluators' "not in the rule's
            // config tree" errors own the unknown-id case; the planner only guards the chain.
            var (tree, _, _, parentId) = LookupChain();

            var plan = QueryExecutionPlan.Build(tree, new List<RuleCondition> { FieldComparisonOn(parentId) }, new[] { Guid.NewGuid() });

            Assert.Equal(2, plan.Levels.Count);
            Assert.Equal(parentId, Assert.Single(plan.Levels[1]).Node.Id);
        }

        [Fact]
        public void Levels_follow_the_tree_depth_and_the_root_is_never_planned()
        {
            var (tree, rootId, customerId, parentId) = LookupChain();

            var plan = QueryExecutionPlan.Build(tree, new List<RuleCondition> { FieldComparisonOn(rootId) }, new[] { parentId, customerId });

            Assert.Equal(2, plan.Levels.Count);
            Assert.DoesNotContain(plan.Levels.SelectMany(l => l), e => e.Node.Id == rootId);
            Assert.Equal(customerId, Assert.Single(plan.Levels[0]).Node.Id);
            Assert.Equal(rootId.ToString(), plan.Levels[0][0].ParentCacheKey);
            Assert.Equal(parentId, Assert.Single(plan.Levels[1]).Node.Id);
        }
    }
}
