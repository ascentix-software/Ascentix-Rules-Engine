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
    public class DateSemanticsTests
    {
        private static readonly DateTime Now = new DateTime(2026, 9, 27, 12, 0, 0, DateTimeKind.Utc);

        private sealed class Kinds : IDateColumnKindProvider
        {
            private readonly DateColumnKind? _kind;
            public Kinds(DateColumnKind? kind) { _kind = kind; }
            public DateColumnKind? GetDateKind(string table, string column) => _kind;
        }

        private static NodeFilterGroup BirthdateSinceYesterday() => new NodeFilterGroup
        {
            LogicalOperator = LogicalOperator.And,
            Criteria =
            {
                new NodeFilterCriterion
                {
                    Kind = CriterionKind.Comparison, FieldName = "birthdate", Operator = "ge",
                    ValueSource = ComparisonValueSource.DateExpression,
                    Value = "{\"anchor\":{\"kind\":\"now\"},\"op\":\"subtract\",\"amount\":1,\"unit\":\"days\"}",
                },
            },
        };

        private static NodeFilterEvaluator Filter(DateSemantics dates)
        {
            var resolver = new FieldValueResolver();
            var values = new ComparisonValueResolver(new QueryResultCache(), TableConfigTree.Empty, resolver, null, Now);
            return new NodeFilterEvaluator(resolver, values) { Dates = dates };
        }

        private static Entity Contact(DateTime birthdate) =>
            new Entity("contact", Guid.NewGuid()) { ["birthdate"] = birthdate };

        [Fact]
        public void Calendar_date_filter_matches_yesterday_whatever_the_time_of_day()
        {
            var eval = Filter(new DateSemantics(new Kinds(DateColumnKind.CalendarDate), TimeZoneInfo.Utc));
            Assert.True(eval.EvaluateFilterGroup(BirthdateSinceYesterday(), new List<Entity> { Contact(new DateTime(2026, 9, 26)) }));
        }

        [Fact]
        public void Without_date_semantics_the_instant_comparison_is_unchanged()
        {
            // Midnight on the 26th is before now − 1 day (12:00 on the 26th).
            var eval = Filter(null);
            Assert.False(eval.EvaluateFilterGroup(BirthdateSinceYesterday(), new List<Entity> { Contact(new DateTime(2026, 9, 26)) }));
        }

        [Fact]
        public void Non_date_values_fall_back_to_the_scalar_comparison()
        {
            var dates = new DateSemantics(new Kinds(DateColumnKind.CalendarDate), TimeZoneInfo.Utc);
            var record = new Entity("contact", Guid.NewGuid()) { ["lastname"] = "2026-09-26" };
            Assert.Null(dates.Compare(record, "lastname", ComparisonOperator.Equals, "2026-09-26"));
            Assert.Null(dates.Compare(record, "missing", ComparisonOperator.Equals, "2026-09-26"));
        }

        private sealed class CountingKinds : IDateColumnKindProvider
        {
            public int Calls;
            public DateColumnKind? GetDateKind(string table, string column) { Calls++; return DateColumnKind.Instant; }
        }

        // Metadata costs a RetrieveEntity per table: only a comparison that can take the date path
        // (eq/ne/gt/ge/lt/le against a date comparand) may ask for the column's behavior.
        [Theory]
        [InlineData(ComparisonOperator.IsNull, "2026-09-26")]
        [InlineData(ComparisonOperator.IsNotNull, null)]
        [InlineData(ComparisonOperator.Contains, "2026")]
        [InlineData(ComparisonOperator.Equals, "not a date")]
        [InlineData(ComparisonOperator.Equals, null)]
        public void Non_date_comparisons_never_read_metadata(ComparisonOperator op, string comparand)
        {
            var kinds = new CountingKinds();
            var dates = new DateSemantics(kinds, TimeZoneInfo.Utc);
            Assert.Null(dates.Compare(Contact(new DateTime(2026, 9, 26)), "birthdate", op, comparand));
            Assert.Equal(0, kinds.Calls);
        }

        [Fact]
        public void A_record_without_a_table_name_never_reads_metadata()
        {
            var kinds = new CountingKinds();
            var dates = new DateSemantics(kinds, TimeZoneInfo.Utc);
            var record = new Entity { ["birthdate"] = new DateTime(2026, 9, 26) };
            Assert.Null(dates.Compare(record, "birthdate", ComparisonOperator.Equals, "2026-09-26"));
            Assert.Equal(0, kinds.Calls);
        }

        [Fact]
        public void A_date_comparison_reads_metadata_once()
        {
            var kinds = new CountingKinds();
            var dates = new DateSemantics(kinds, TimeZoneInfo.Utc);
            Assert.True(dates.Compare(Contact(new DateTime(2026, 9, 26, 0, 0, 0, DateTimeKind.Utc)), "birthdate",
                ComparisonOperator.Equals, "2026-09-26T00:00:00Z"));
            Assert.Equal(1, kinds.Calls);
        }

        // ── anchors: offset-less or instant by the anchor column's behavior ──────────────────
        //
        // A Date Only / Time Zone Independent anchor is a calendar / wall-clock value, a User Local
        // anchor an instant (spec §4.2). Which one is read from the anchor column's metadata, not
        // from the DateTimeKind the SDK happens to return. Here the SDK returns the Date Only
        // birthdate with DateTimeKind.Utc, and the anchor is birthdate + 1 hour: read by its Kind,
        // it would be the instant 01:00Z; read by its behavior, it is Sep 1 01:00 in the rule's
        // zone, Eastern: 05:00Z.

        private static readonly TimeZoneInfo Eastern = TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");

        private sealed class ColumnKinds : IDateColumnKindProvider
        {
            private readonly Dictionary<string, DateColumnKind> _kinds;
            public ColumnKinds(Dictionary<string, DateColumnKind> kinds) { _kinds = kinds; }
            public DateColumnKind? GetDateKind(string table, string column) =>
                _kinds.TryGetValue(column, out var k) ? k : (DateColumnKind?)null;
        }

        private static DateSemantics BirthdateIsDateOnly(bool anchorKnown) => new DateSemantics(new ColumnKinds(
            anchorKnown
                ? new Dictionary<string, DateColumnKind> { ["createdon"] = DateColumnKind.Instant, ["birthdate"] = DateColumnKind.CalendarDate }
                : new Dictionary<string, DateColumnKind> { ["createdon"] = DateColumnKind.Instant }),
            Eastern);

        private static Entity CreatedAfterBirthday() => new Entity("contact", Guid.NewGuid())
        {
            ["birthdate"] = new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc),   // Date Only, Utc-kinded
            ["createdon"] = new DateTime(2026, 9, 1, 2, 0, 0, DateTimeKind.Utc),   // 22:00 EDT on Aug 31
        };

        private const string BirthdateOfThisRow = "{\"anchor\":{\"kind\":\"field\",\"node\":null,\"column\":\"birthdate\"},\"op\":\"add\",\"amount\":1,\"unit\":\"hours\"}";

        private static NodeFilterGroup CreatedOnOrAfterBirthdate() => new NodeFilterGroup
        {
            LogicalOperator = LogicalOperator.And,
            Criteria =
            {
                new NodeFilterCriterion
                {
                    Kind = CriterionKind.Comparison, FieldName = "createdon", Operator = "ge",
                    ValueSource = ComparisonValueSource.DateExpression, Value = BirthdateOfThisRow,
                },
            },
        };

        [Fact]
        public void A_date_only_anchor_is_a_calendar_value_whatever_kind_the_sdk_returns()
        {
            // createdon 02:00Z is before Sep 1 01:00 Eastern (05:00Z).
            var eval = Filter(BirthdateIsDateOnly(anchorKnown: true));
            Assert.False(eval.EvaluateFilterGroup(CreatedOnOrAfterBirthdate(), new List<Entity> { CreatedAfterBirthday() }));
        }

        [Fact]
        public void Without_the_anchors_behavior_the_sdk_kind_decides()
        {
            // The documented fallback: a Utc-kinded anchor with no known behavior is an instant
            // (01:00Z), and createdon 02:00Z is after it.
            var eval = Filter(BirthdateIsDateOnly(anchorKnown: false));
            Assert.True(eval.EvaluateFilterGroup(CreatedOnOrAfterBirthdate(), new List<Entity> { CreatedAfterBirthday() }));
        }

        [Fact]
        public void Condition_anchors_take_their_behavior_from_metadata_too()
        {
            var rootId = Guid.NewGuid();
            var tree = TestTree.Tree(new TableConfig { Id = rootId, TableLogicalName = "contact", ConfigType = TableConfigType.RootTable });
            var root = CreatedAfterBirthday();
            var cache = new QueryResultCache();
            cache.Store(rootId, new List<Entity> { root });
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(), TableConfigNodeId = rootId, ConditionType = ConditionType.FieldComparison,
                ComparisonColumn = "createdon", ComparisonOperator = ComparisonOperator.GreaterThanOrEqual,
                ValueSource = ComparisonValueSource.DateExpression,
                ComparisonValue = "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + rootId + "\",\"column\":\"birthdate\"},\"op\":\"add\",\"amount\":1,\"unit\":\"hours\"}",
            };
            var eval = new ConditionEvaluator(cache, tree, new FieldValueResolver(), null, Now);

            eval.Dates = BirthdateIsDateOnly(anchorKnown: false);
            Assert.True(eval.EvaluateCondition(condition, new ConditionGroup(), root).Passed);
            eval.Dates = BirthdateIsDateOnly(anchorKnown: true);
            Assert.False(eval.EvaluateCondition(condition, new ConditionGroup(), root).Passed);
        }

        [Fact]
        public void Condition_comparisons_use_the_rules_date_semantics()
        {
            var rootId = Guid.NewGuid();
            var tree = TestTree.Tree(new TableConfig { Id = rootId, TableLogicalName = "contact", ConfigType = TableConfigType.RootTable });
            var root = Contact(new DateTime(2026, 9, 26));
            var cache = new QueryResultCache();
            cache.Store(rootId, new List<Entity> { root });
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(), TableConfigNodeId = rootId, ConditionType = ConditionType.FieldComparison,
                ComparisonColumn = "birthdate", ComparisonOperator = ComparisonOperator.GreaterThanOrEqual,
                ComparisonValue = "2026-09-26T12:00:00Z",
            };
            var eval = new ConditionEvaluator(cache, tree, new FieldValueResolver(), null, Now);

            Assert.False(eval.EvaluateCondition(condition, new ConditionGroup(), root).Passed);
            eval.Dates = new DateSemantics(new Kinds(DateColumnKind.CalendarDate), TimeZoneInfo.Utc);
            Assert.True(eval.EvaluateCondition(condition, new ConditionGroup(), root).Passed);
        }
    }
}
