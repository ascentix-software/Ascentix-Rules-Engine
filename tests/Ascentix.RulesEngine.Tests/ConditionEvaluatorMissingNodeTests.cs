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
    // Reproduces the orphaned-rule shape: ConditionGroupMapper maps a null
    // asx_tableconfignode lookup to Guid.Empty, which is never seeded into
    // ConditionEvaluator's _configs. Every write to the rule's table must fail with a
    // clear InvalidPluginExecutionException naming the node, not a raw KeyNotFoundException
    // surfaced to Dataverse as the opaque 0x80040224 fault.
    public class ConditionEvaluatorMissingNodeTests
    {
        [Fact]
        public void EvaluateCondition_throws_clear_error_when_TableConfigNodeId_is_not_in_the_config_tree()
        {
            // _configs is seeded with a real root node, but the condition references a
            // different (unseeded) node id -- the orphaned-rule shape.
            var seededNodeId = Guid.NewGuid();
            var seededNode = new TableConfig
            {
                Id = seededNodeId,
                TableLogicalName = "account",
                ConfigType = TableConfigType.RootTable,
            };
            var configs = TestTree.Tree(seededNode);

            var cache = new QueryResultCache();
            cache.Store(seededNodeId, new List<Entity> { new Entity("account", Guid.NewGuid()) });

            var eval = new ConditionEvaluator(cache, configs, new FieldValueResolver());

            var missingNodeId = Guid.Empty;
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ConditionType = ConditionType.FieldComparison,
                TableConfigNodeId = missingNodeId,
                ComparisonColumn = "name",
                ComparisonOperator = ComparisonOperator.Equals,
                ComparisonValue = "Acme",
                ValueSource = ComparisonValueSource.Literal,
            };
            var group = new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup>() };

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => eval.EvaluateCondition(condition, group));

            Assert.Contains(condition.Id.ToString(), ex.Message);
            Assert.Contains(missingNodeId.ToString(), ex.Message);
            Assert.Contains("not in the rule's config tree", ex.Message);
        }
    }
}
