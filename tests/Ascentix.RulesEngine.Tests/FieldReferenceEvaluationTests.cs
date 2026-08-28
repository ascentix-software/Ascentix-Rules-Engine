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
    public class FieldReferenceEvaluationTests
    {
        // A root-only condition: actualend >= actualstart (same-record field ref).
        [Fact]
        public void Same_record_field_ref_passes_when_lhs_meets_rhs()
        {
            var rootId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable }
            );
            var cache = new QueryResultCache();
            cache.Store(rootId, new List<Entity>
            {
                new Entity("appointment") { ["actualstart"] = 5, ["actualend"] = 9 } // 9 >= 5 → pass
            });

            var result = Evaluate(rootId, configs, cache, new RuleCondition
            {
                TableConfigNodeId = rootId,
                ConditionType = ConditionType.FieldComparison,
                ComparisonColumn = "actualend",
                ComparisonOperator = ComparisonOperator.GreaterThanOrEqual,
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueColumn = "actualstart",   // same-record
            });

            Assert.True(result.Passed);
        }

        [Fact]
        public void Same_record_field_ref_fails_when_lhs_below_rhs()
        {
            var rootId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable }
            );
            var cache = new QueryResultCache();
            cache.Store(rootId, new List<Entity>
            {
                new Entity("appointment") { ["actualstart"] = 9, ["actualend"] = 5 } // 5 >= 9 → fail
            });

            var result = Evaluate(rootId, configs, cache, new RuleCondition
            {
                TableConfigNodeId = rootId,
                ConditionType = ConditionType.FieldComparison,
                ComparisonColumn = "actualend",
                ComparisonOperator = ComparisonOperator.GreaterThanOrEqual,
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueColumn = "actualstart",
            });

            Assert.False(result.Passed);
        }

        private static ConditionEvaluationResult Evaluate(
            Guid rootId, TableConfigTree configs, QueryResultCache cache, RuleCondition condition)
        {
            var evaluator = new ConditionEvaluator(cache, configs, new FieldValueResolver());
            var group = new ConditionGroup { Id = Guid.NewGuid(), Conditions = { condition } };
            return evaluator.EvaluateCondition(condition, group);
        }
    }
}
