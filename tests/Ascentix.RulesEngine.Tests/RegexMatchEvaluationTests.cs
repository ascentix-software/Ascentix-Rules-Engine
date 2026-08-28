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
    public class RegexMatchEvaluationTests
    {
        private const string EmailPattern = @"^[^@\s]+@[^@\s]+\.[^@\s]+$";

        [Fact]
        public void Matching_value_passes()
        {
            var result = Evaluate("user@example.com", EmailPattern);
            Assert.True(result.Passed);
        }

        [Fact]
        public void Non_matching_value_fails()
        {
            var result = Evaluate("not-an-email", EmailPattern);
            Assert.False(result.Passed);
        }

        [Fact]
        public void Null_value_is_treated_as_empty_and_fails_a_nonempty_pattern()
        {
            var result = Evaluate(null, EmailPattern);
            Assert.False(result.Passed);
        }

        [Fact]
        public void Missing_pattern_throws()
        {
            Assert.Throws<InvalidPluginExecutionException>(() => Evaluate("anything", null));
        }

        [Fact]
        public void Invalid_pattern_throws()
        {
            Assert.Throws<InvalidPluginExecutionException>(() => Evaluate("anything", "([unterminated"));
        }

        private static ConditionEvaluationResult Evaluate(string columnValue, string pattern)
        {
            var rootId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable }
            );
            var cache = new QueryResultCache();
            var record = new Entity("contact");
            if (columnValue != null) record["emailaddress1"] = columnValue;
            cache.Store(rootId, new List<Entity> { record });

            var condition = new RuleCondition
            {
                TableConfigNodeId = rootId,
                ConditionType = ConditionType.RegexMatch,
                ComparisonColumn = "emailaddress1",
                ComparisonValue = pattern,
            };

            var evaluator = new ConditionEvaluator(cache, configs, new FieldValueResolver());
            var group = new ConditionGroup { Id = Guid.NewGuid(), Conditions = { condition } };
            return evaluator.EvaluateCondition(condition, group);
        }
    }
}
