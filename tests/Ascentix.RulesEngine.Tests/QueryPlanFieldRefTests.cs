using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class QueryPlanFieldRefTests
    {
        [Fact]
        public void Plan_includes_a_cross_node_lookup_rhs_so_it_gets_queried()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable },
                new TableConfig
                {
                    Id = lookupId, ConfigType = TableConfigType.LookupTable,
                    ParentTableId = rootId, LookupColumnLogicalName = "primarycontactid"
                });

            // A condition ON the root whose RHS references the lookup node's column.
            var condition = new RuleCondition
            {
                TableConfigNodeId = rootId,
                ComparisonColumn = "ownerid",
                ComparisonOperator = ComparisonOperator.Equals,
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = lookupId,
                ComparisonValueColumn = "ownerid",
            };

            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition> { condition });

            var plannedNodeIds = plan.Levels.SelectMany(l => l).Select(e => e.Node.Id).ToList();
            Assert.Contains(lookupId, plannedNodeIds);   // lookup RHS is queried
        }

        [Fact]
        public void Root_rhs_adds_no_plan_entry_because_the_root_is_seeded()
        {
            var rootId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable });
            var condition = new RuleCondition
            {
                TableConfigNodeId = rootId,
                ComparisonColumn = "actualend",
                ComparisonOperator = ComparisonOperator.GreaterThanOrEqual,
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = rootId,            // RHS = root
                ComparisonValueColumn = "actualstart",
            };

            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition> { condition });

            Assert.Empty(plan.Levels.SelectMany(l => l));   // nothing to query; root is seeded
        }

        [Fact]
        public void Plan_includes_every_hop_of_a_deep_lookup_chain_rhs()
        {
            // root -> lookup A (depth 1) -> lookup B (depth 2); the RHS references B.
            var rootId = Guid.NewGuid();
            var aId = Guid.NewGuid();
            var bId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = aId, ConfigType = TableConfigType.LookupTable, ParentTableId = rootId },
                new TableConfig { Id = bId, ConfigType = TableConfigType.LookupTable, ParentTableId = aId });
            var condition = new RuleCondition
            {
                TableConfigNodeId = rootId,
                ComparisonColumn = "x",
                ComparisonOperator = ComparisonOperator.Equals,
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = bId,   // deep RHS (root -> A -> B)
                ComparisonValueColumn = "y",
            };

            var plan = QueryExecutionPlan.Build(configs, new List<RuleCondition> { condition });
            var plannedNodeIds = plan.Levels.SelectMany(l => l).Select(e => e.Node.Id).ToList();

            Assert.Contains(aId, plannedNodeIds);   // intermediate hop is queried before B
            Assert.Contains(bId, plannedNodeIds);   // the deep RHS itself is queried
        }
    }
}
