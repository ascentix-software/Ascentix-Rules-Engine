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
    public class ConditionEvaluatorComparisonTests
    {
        // Single root node "account"; one cached record. Returns the evaluator + node.
        private static (ConditionEvaluator eval, TableConfig node, QueryResultCache cache) Setup(Entity record)
        {
            var nodeId = Guid.NewGuid();
            var node = new TableConfig { Id = nodeId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable };
            var configs = TestTree.Tree(node);
            var cache = new QueryResultCache();
            cache.Store(nodeId, new List<Entity> { record });
            return (new ConditionEvaluator(cache, configs, new FieldValueResolver()), node, cache);
        }

        private static RuleCondition Cond(Guid nodeId, string col, ComparisonOperator op, string value)
            => new RuleCondition
            {
                Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison,
                TableConfigNodeId = nodeId, ComparisonColumn = col,
                ComparisonOperator = op, ComparisonValue = value,
                ValueSource = ComparisonValueSource.Literal,
            };

        private static ConditionGroup Group() => new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup>() };

        [Fact]
        public void DateTime_greater_than_compares_as_date()
        {
            var rec = new Entity("account", Guid.NewGuid()) { ["createdon"] = new DateTime(2026, 6, 1) };
            var (eval, node, _) = Setup(rec);
            var passed = eval.EvaluateCondition(Cond(node.Id, "createdon", ComparisonOperator.GreaterThan, "2026-01-01"), Group()).Passed;
            Assert.True(passed); // 2026-06-01 > 2026-01-01
        }

        [Fact]
        public void DateTime_less_than_false_when_after()
        {
            var rec = new Entity("account", Guid.NewGuid()) { ["createdon"] = new DateTime(2026, 6, 1) };
            var (eval, node, _) = Setup(rec);
            var passed = eval.EvaluateCondition(Cond(node.Id, "createdon", ComparisonOperator.LessThan, "2026-01-01"), Group()).Passed;
            Assert.False(passed);
        }

        [Fact]
        public void Ordering_on_text_does_not_throw_and_no_match()
        {
            var rec = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme" };
            var (eval, node, _) = Setup(rec);
            // GreaterThan reaches the string path (non-numeric, non-date) -> fail-safe false, no throw.
            var result = eval.EvaluateCondition(Cond(node.Id, "name", ComparisonOperator.GreaterThan, "Aardvark"), Group());
            Assert.False(result.Passed);
        }

        [Fact]
        public void IsNull_is_satisfied_when_the_column_is_absent()
        {
            // Live Dataverse omits a null column from the Entity entirely, so IsNull's real-world
            // input is an ABSENT attribute (not a present-null). The condition must be satisfied.
            var rec = new Entity("account", Guid.NewGuid()); // no "name" attribute at all
            var (eval, node, _) = Setup(rec);
            var result = eval.EvaluateCondition(Cond(node.Id, "name", ComparisonOperator.IsNull, null), Group());
            Assert.True(result.Passed); // absent column == null -> IsNull holds
        }

        [Fact]
        public void IsNotNull_is_not_satisfied_when_the_column_is_absent()
        {
            // Regression guard: an absent column is null, so IsNotNull must NOT be satisfied.
            var rec = new Entity("account", Guid.NewGuid()); // no "name" attribute
            var (eval, node, _) = Setup(rec);
            var result = eval.EvaluateCondition(Cond(node.Id, "name", ComparisonOperator.IsNotNull, null), Group());
            Assert.False(result.Passed);
        }

        [Fact]
        public void Equals_is_not_satisfied_when_the_column_is_absent()
        {
            // Regression guard: absent column stays not-satisfied for value operators.
            var rec = new Entity("account", Guid.NewGuid()); // no "name" attribute
            var (eval, node, _) = Setup(rec);
            var result = eval.EvaluateCondition(Cond(node.Id, "name", ComparisonOperator.Equals, "Acme"), Group());
            Assert.False(result.Passed);
        }

        [Fact]
        public void DateExpression_rhs_now_plus_3_days_flows_through_the_date_aware_comparison()
        {
            // Both the LHS field and the DateExpression RHS are Kind=Utc, so both round-trip
            // through IFieldValueResolver's "o" format and DateTime.TryParse(..., DateTimeStyles.None)
            // identically (same local-offset conversion on both sides), so ordering is preserved
            // regardless of the test machine's local time zone.
            var utcNow = new DateTime(2026, 7, 12, 9, 0, 0, DateTimeKind.Utc);
            var nodeId = Guid.NewGuid();
            var node = new TableConfig { Id = nodeId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable };
            var configs = TestTree.Tree(node);
            var cache = new QueryResultCache();
            var later = new Entity("account", Guid.NewGuid()) { ["orderdate"] = new DateTime(2026, 7, 20, 0, 0, 0, DateTimeKind.Utc) };
            cache.Store(nodeId, new List<Entity> { later });

            var eval = new ConditionEvaluator(cache, configs, new FieldValueResolver(), null, utcNow);
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ConditionType = ConditionType.FieldComparison,
                TableConfigNodeId = nodeId,
                ComparisonColumn = "orderdate",
                ComparisonOperator = ComparisonOperator.LessThan,
                ValueSource = ComparisonValueSource.DateExpression,
                ComparisonValue = "{\"anchor\":{\"kind\":\"now\"},\"op\":\"add\",\"amount\":3,\"unit\":\"days\"}",
            };

            var notFires = eval.EvaluateCondition(condition, Group(), new Entity("account"));
            Assert.False(notFires.Passed); // 2026-07-20 is not < now+3days(2026-07-15)

            // Same setup but with an earlier orderdate -> condition passes (fires "before" check).
            var earlier = new Entity("account", Guid.NewGuid()) { ["orderdate"] = new DateTime(2026, 7, 10, 0, 0, 0, DateTimeKind.Utc) };
            var cache2 = new QueryResultCache();
            cache2.Store(nodeId, new List<Entity> { earlier });
            var eval2 = new ConditionEvaluator(cache2, configs, new FieldValueResolver(), null, utcNow);
            var passes = eval2.EvaluateCondition(condition, Group(), new Entity("account"));
            Assert.True(passes.Passed); // 2026-07-10 < now+3days(2026-07-15)
        }

        [Fact]
        public void DateExpression_rhs_field_anchor_flows_through_the_double_round_trip_comparison()
        {
            // Field anchor (anchor.kind == "field", AnchorNode == null -> reads the ROOT record)
            // is the subtlest DateExpression path: the anchor value round-trips through
            // IFieldValueResolver ("o" format -> DateTime.TryParse) once to resolve the anchor,
            // DateMath is applied, then the result round-trips a SECOND time (formatted back to
            // an "o" string in ComparisonValueResolver, then re-parsed by the LHS date-aware
            // comparison here). DateTimeKind.Utc consistently on both the anchor field and the
            // LHS field, plus an injected utcNow, keeps this deterministic regardless of the
            // test machine's local time zone (both sides shift by the same local offset, so
            // relative ordering survives even though absolute values do not). See
            // ComparisonValueResolverTests / DateExprEvaluatorTests for the same characteristic.
            var utcNow = new DateTime(2026, 7, 12, 9, 0, 0, DateTimeKind.Utc);
            var nodeId = Guid.NewGuid();
            var node = new TableConfig { Id = nodeId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable };
            var configs = TestTree.Tree(node);

            var anchorSource = new DateTime(2026, 7, 1, 0, 0, 0, DateTimeKind.Utc); // root.createdon
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ConditionType = ConditionType.FieldComparison,
                TableConfigNodeId = nodeId,
                ComparisonColumn = "orderdate",
                ComparisonOperator = ComparisonOperator.GreaterThan,
                ValueSource = ComparisonValueSource.DateExpression,
                ComparisonValue = "{\"anchor\":{\"kind\":\"field\",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":5,\"unit\":\"days\"}",
                // RHS = root.createdon (2026-07-01) + 5 days = 2026-07-06
            };

            // orderdate AFTER anchor+5days -> condition fires.
            var laterRoot = new Entity("account", Guid.NewGuid()) { ["createdon"] = anchorSource };
            var laterCache = new QueryResultCache();
            laterCache.Store(nodeId, new List<Entity>
            {
                new Entity("account") { ["orderdate"] = new DateTime(2026, 7, 10, 0, 0, 0, DateTimeKind.Utc) },
            });
            var laterEval = new ConditionEvaluator(laterCache, configs, new FieldValueResolver(), null, utcNow);
            var fires = laterEval.EvaluateCondition(condition, Group(), laterRoot);
            Assert.True(fires.Passed); // 2026-07-10 > anchor(2026-07-01)+5days(2026-07-06)

            // orderdate BEFORE anchor+5days -> condition does not fire.
            var earlierRoot = new Entity("account", Guid.NewGuid()) { ["createdon"] = anchorSource };
            var earlierCache = new QueryResultCache();
            earlierCache.Store(nodeId, new List<Entity>
            {
                new Entity("account") { ["orderdate"] = new DateTime(2026, 7, 3, 0, 0, 0, DateTimeKind.Utc) },
            });
            var earlierEval = new ConditionEvaluator(earlierCache, configs, new FieldValueResolver(), null, utcNow);
            var notFires = earlierEval.EvaluateCondition(condition, Group(), earlierRoot);
            Assert.False(notFires.Passed); // 2026-07-03 is not > anchor(2026-07-01)+5days(2026-07-06)
        }
    }
}
