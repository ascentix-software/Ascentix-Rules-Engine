using System;
using System.Collections.Generic;
using System.Globalization;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>On Create the Target has no createdon/modifiedon yet: a date expression anchored on
    /// either column of the record being created reads the run's evaluation instant.</summary>
    public class NewRecordStampTests
    {
        private static readonly DateTime Now = new DateTime(2026, 9, 27, 12, 0, 0, DateTimeKind.Utc);
        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid LineId = Guid.NewGuid();

        private static (QueryResultCache cache, TableConfigTree tree, Entity root) Setup()
        {
            var tree = TestTree.Tree(
                new TableConfig { Id = RootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = LineId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable,
                    ParentTableId = RootId, ChildLinkField = "sample_orderid" });
            var root = new Entity("sample_order", Guid.NewGuid()); // a Create's Target: no createdon yet
            var cache = new QueryResultCache();
            cache.Store(RootId, new List<Entity> { root });
            return (cache, tree, root);
        }

        private static RuleCondition CreatedOnPlusOneDay() => new RuleCondition
        {
            Id = Guid.NewGuid(),
            ValueSource = ComparisonValueSource.DateExpression,
            ComparisonValue = "{\"anchor\":{\"kind\":\"field\",\"node\":null,\"column\":\"createdon\"},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}",
        };

        [Fact]
        public void Filter_anchor_on_the_root_being_created_reads_the_evaluation_instant()
        {
            var (cache, tree, root) = Setup();
            var resolver = new FieldValueResolver();
            var values = new ComparisonValueResolver(cache, tree, resolver, null, Now, new NewRecordStamp(root, Now));
            var eval = new NodeFilterEvaluator(resolver, values, cache, tree);
            var group = new NodeFilterGroup
            {
                LogicalOperator = LogicalOperator.And,
                Criteria =
                {
                    new NodeFilterCriterion
                    {
                        Kind = CriterionKind.Comparison, FieldName = "createdon", Operator = "gt",
                        ValueSource = ComparisonValueSource.DateExpression,
                        Value = "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + RootId + "\",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":30,\"unit\":\"days\"}",
                    },
                },
            };

            var late = new Entity("sample_orderline", Guid.NewGuid()) { ["createdon"] = Now.AddDays(31) };
            var early = new Entity("sample_orderline", Guid.NewGuid()) { ["createdon"] = Now.AddDays(29) };
            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { late }, LineId));
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { early }, LineId));
        }

        [Fact]
        public void Condition_anchor_on_the_root_being_created_reads_the_evaluation_instant()
        {
            var (cache, tree, root) = Setup();
            var values = new ComparisonValueResolver(cache, tree, new FieldValueResolver(), null, Now, new NewRecordStamp(root, Now));

            var rhs = values.Resolve(CreatedOnPlusOneDay(), root, root);

            Assert.Equal(Now.AddDays(1), DateTime.Parse(rhs, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal));
        }

        [Fact]
        public void A_record_that_is_not_being_created_is_not_stamped()
        {
            var (cache, tree, root) = Setup();
            var values = new ComparisonValueResolver(cache, tree, new FieldValueResolver(), null, Now);

            Assert.Throws<InvalidPluginExecutionException>(() => values.Resolve(CreatedOnPlusOneDay(), root, root));
        }

        [Fact]
        public void Only_platform_stamps_are_filled()
        {
            var root = new Entity("sample_order", Guid.NewGuid());
            var stamp = new NewRecordStamp(root, Now);

            Assert.Equal(Now, NewRecordStamp.Fill(stamp, root, "modifiedon", null));
            Assert.Null(NewRecordStamp.Fill(stamp, root, "sample_duedate", null));
            Assert.Null(NewRecordStamp.Fill(stamp, new Entity("sample_order", Guid.NewGuid()), "createdon", null));
        }

        [Fact]
        public void Created_on_reads_an_overridden_created_on_when_the_create_sets_one()
        {
            // The platform stores a Create's overriddencreatedon as createdon; modifiedon is still
            // the time of the write.
            var overridden = new DateTime(2020, 1, 15, 9, 0, 0, DateTimeKind.Utc);
            var root = new Entity("sample_order", Guid.NewGuid()) { ["overriddencreatedon"] = overridden };
            var stamp = new NewRecordStamp(root, Now);

            Assert.Equal(overridden, NewRecordStamp.Fill(stamp, root, "createdon", null));
            Assert.Equal(Now, NewRecordStamp.Fill(stamp, root, "modifiedon", null));
        }

        [Fact]
        public void Created_on_reads_the_evaluation_instant_when_the_override_is_null()
        {
            var root = new Entity("sample_order", Guid.NewGuid()) { ["overriddencreatedon"] = null };
            var stamp = new NewRecordStamp(root, Now);

            Assert.Equal(Now, NewRecordStamp.Fill(stamp, root, "createdon", null));
        }
    }
}
