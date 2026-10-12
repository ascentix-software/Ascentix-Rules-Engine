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
    /// <summary>Calculation (Expression) conditions whose aggregates carry filter:&lt;key&gt;,
    /// resolved against the condition's ExpressionFilters map.</summary>
    public class ExpressionConditionFilterTests
    {
        private static readonly DateTime Now = new DateTime(2026, 9, 26, 12, 0, 0, DateTimeKind.Utc);
        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid OppId = Guid.NewGuid();

        private static (ConditionEvaluator eval, Entity root) Setup()
        {
            var tree = TestTree.Tree(
                new TableConfig { Id = RootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = OppId, TableLogicalName = "opportunity", ConfigType = TableConfigType.ChildTable,
                    ParentTableId = RootId, ChildLinkField = "parentaccountid" });
            var root = new Entity("account", Guid.NewGuid());
            var cache = new QueryResultCache();
            cache.Store(RootId, new List<Entity> { root });
            cache.Store(OppId, new List<Entity>
            {
                new Entity("opportunity", Guid.NewGuid()) { ["statecode"] = new OptionSetValue(0), ["estimatedvalue"] = new Money(900000m), ["actualclosedate"] = Now.AddDays(-400) },
                new Entity("opportunity", Guid.NewGuid()) { ["statecode"] = new OptionSetValue(0), ["estimatedvalue"] = new Money(300000m), ["actualclosedate"] = Now.AddDays(-30) },
                new Entity("opportunity", Guid.NewGuid()) { ["statecode"] = new OptionSetValue(1), ["estimatedvalue"] = new Money(5000000m), ["actualclosedate"] = Now.AddDays(-10) },
            });
            return (new ConditionEvaluator(cache, tree, new FieldValueResolver(), null, Now), root);
        }

        private static RuleCondition Cond(string expression, string filtersJson, string threshold) => new RuleCondition
        {
            Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = RootId,
            Expression = expression, ExpressionFilters = filtersJson,
            ComparisonOperator = ComparisonOperator.GreaterThan,
            ValueSource = ComparisonValueSource.Literal, ComparisonValue = threshold,
        };

        private static ConditionGroup Group() => new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup>() };

        private const string OpenOnly =
            "{\"f1\":{\"kind\":\"group\",\"op\":\"and\",\"rules\":[{\"kind\":\"rule\",\"column\":\"statecode\",\"operator\":1,\"valueSource\":1,\"value\":\"0\"}]}}";

        [Fact]
        public void Filtered_sum_counts_only_matching_rows()
        {
            var (eval, root) = Setup();
            var expr = $"sum(node:{OppId}.estimatedvalue filter:f1)";

            Assert.True(eval.EvaluateCondition(Cond(expr, OpenOnly, "1000000"), Group(), root).Passed);   // 1.2M open
            Assert.False(eval.EvaluateCondition(Cond(expr, OpenOnly, "2000000"), Group(), root).Passed);  // not 6.2M
        }

        [Fact]
        public void Filtered_sum_with_a_relative_date_window()
        {
            var (eval, root) = Setup();
            var payload = "{\\\"anchor\\\":{\\\"kind\\\":\\\"now\\\"},\\\"op\\\":\\\"subtract\\\",\\\"amount\\\":12,\\\"unit\\\":\\\"months\\\"}";
            var lastYear = "{\"f1\":{\"kind\":\"group\",\"op\":\"and\",\"rules\":[{\"kind\":\"rule\",\"column\":\"actualclosedate\",\"operator\":4,\"valueSource\":4,\"value\":\"" + payload + "\"}]}}";
            var expr = $"sum(node:{OppId}.estimatedvalue filter:f1)";

            // rows closed in the last 12 months: 300k + 5M = 5.3M
            Assert.True(eval.EvaluateCondition(Cond(expr, lastYear, "5000000"), Group(), root).Passed);
            Assert.False(eval.EvaluateCondition(Cond(expr, lastYear, "6000000"), Group(), root).Passed);
        }

        [Fact]
        public void Undefined_filter_key_throws()
        {
            var (eval, root) = Setup();
            var cond = Cond($"sum(node:{OppId}.estimatedvalue filter:f2)", OpenOnly, "0");

            Assert.Throws<InvalidPluginExecutionException>(() => eval.EvaluateCondition(cond, Group(), root));
        }

        [Fact]
        public void Unfiltered_expression_ignores_a_null_filters_column()
        {
            var (eval, root) = Setup();
            Assert.True(eval.EvaluateCondition(Cond($"sum(node:{OppId}.estimatedvalue)", null, "6000000"), Group(), root).Passed);
        }
    }
}
