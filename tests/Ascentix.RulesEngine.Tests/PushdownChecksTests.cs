using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;
using LogicalOperator = Ascentix.RulesEngine.Core.Models.LogicalOperator;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>TRAV_PUSHDOWN advisory + the engine-settings kill switch read.</summary>
    public class PushdownChecksTests
    {
        private static readonly Guid NodeId = Guid.NewGuid();

        private static RuleForValidation Model(NodeFilterGroup filter, RuleCondition cond)
        {
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                Conditions = new List<RuleCondition> { cond },
                NodeFilterGroups = filter == null ? new List<NodeFilterGroup>() : new List<NodeFilterGroup> { filter },
            };
            return new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                PrimaryTable = "sample_order",
                Groups = new List<ConditionGroup> { group },
                Configs = TestTree.RawTree(
                    new TableConfig { Id = NodeId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_orderid" }),
                Actions = new List<RuleAction>(),
            };
        }

        private static RuleCondition RowCount() => new RuleCondition
        { Id = Guid.NewGuid(), TableConfigNodeId = NodeId, ConditionType = ConditionType.RowCount, MinExpectedRows = 1 };

        [Fact]
        public void Residual_criteria_produce_the_warning()
        {
            var cond = RowCount();
            var filter = new NodeFilterGroup
            {
                TableConfigNodeId = NodeId,
                RuleConditionId = cond.Id,
                LogicalOperator = LogicalOperator.And,
                Criteria = { new NodeFilterCriterion { FieldName = "sample_name", Operator = "contains", Value = "x" } },
            };
            var issues = PushdownChecks.Check(Model(filter, cond));
            var w = Assert.Single(issues);
            Assert.Equal(PushdownChecks.CodePushdownResidual, w.Code);
            Assert.Equal(IssueSeverity.Warning, w.Severity);
            Assert.Contains("sample_orderline", w.Message);
            Assert.Equal(cond.Id, w.Target.Id);
        }

        [Fact]
        public void Fully_pushable_criteria_produce_no_warning()
        {
            var cond = RowCount();
            cond.SearchCriteriaGroups.Add(new SearchCriteriaGroup
            {
                LogicalOperator = LogicalOperator.And,
                Criteria = { new SearchCriterion { FieldName = "statecode", Operator = "eq", Value = "0" } },
            });
            Assert.Empty(PushdownChecks.Check(Model(null, cond)));
        }

        [Fact]
        public void Unfiltered_conditions_are_silent()
        {
            Assert.Empty(PushdownChecks.Check(Model(null, RowCount())));
        }

        [Fact]
        public void Out_of_range_date_expression_does_not_throw()
        {
            var cond = RowCount();
            var filter = new NodeFilterGroup
            {
                TableConfigNodeId = NodeId,
                RuleConditionId = cond.Id,
                LogicalOperator = LogicalOperator.And,
                Criteria = { new NodeFilterCriterion { FieldName = "createdon", Operator = "ge",
                    ValueSource = ComparisonValueSource.DateExpression, Value = "{\"anchor\":{\"kind\":\"now\"},\"op\":\"subtract\",\"amount\":20000,\"unit\":\"years\"}" } },
            };
            var w = Assert.Single(PushdownChecks.Check(Model(filter, cond)));
            Assert.Equal(PushdownChecks.CodePushdownResidual, w.Code);
        }

        // ── the warning follows the runtime's column behaviors and zone (spec §3.5) ──────────

        private sealed class Kinds : IDateColumnKindProvider
        {
            private readonly string _column;
            private readonly DateColumnKind _kind;
            public Kinds(string column, DateColumnKind kind) { _column = column; _kind = kind; }
            public DateColumnKind? GetDateKind(string table, string column) =>
                table == "sample_orderline" && column == _column ? _kind : (DateColumnKind?)null;
        }

        private static RuleForValidation LiteralModel(string field, string op, string value, string zone = null)
        {
            var cond = RowCount();
            var model = Model(new NodeFilterGroup
            {
                TableConfigNodeId = NodeId,
                RuleConditionId = cond.Id,
                LogicalOperator = LogicalOperator.And,
                Criteria = { new NodeFilterCriterion { Kind = CriterionKind.Comparison, FieldName = field, Operator = op, Value = value } },
            }, cond);
            model.RuleEntity = new Entity("asx_rule", model.RuleId);
            if (zone != null) model.RuleEntity[Ascentix.RulesEngine.Schema.SchemaNames.Qualify(Ascentix.RulesEngine.Schema.SchemaNames.Rule.EvaluationTimeZone)] = zone;
            return model;
        }

        [Fact]
        public void Date_equality_on_a_date_only_column_pushes_so_it_does_not_warn()
        {
            var model = LiteralModel("sample_duedate", "eq", "2026-09-01", "Eastern Standard Time");
            Assert.Empty(PushdownChecks.Check(model, new Kinds("sample_duedate", DateColumnKind.CalendarDate)));
        }

        [Fact]
        public void Date_equality_without_metadata_warns()
        {
            var model = LiteralModel("sample_duedate", "eq", "2026-09-01");
            Assert.Single(PushdownChecks.Check(model), i => i.Code == PushdownChecks.CodePushdownResidual);
        }

        // Ruling 2: metadata says the column is not a date, so the runtime keeps a date-looking
        // range literal in memory; the warning must say so.
        [Fact]
        public void Date_like_range_literal_on_a_text_column_warns()
        {
            var model = LiteralModel("sample_notes", "ge", "2026-09-01");
            Assert.Single(PushdownChecks.Check(model, new Kinds("sample_duedate", DateColumnKind.CalendarDate)),
                i => i.Code == PushdownChecks.CodePushdownResidual);
        }

        [Fact]
        public void An_unknown_zone_does_not_throw_and_reads_as_utc()
        {
            var model = LiteralModel("sample_duedate", "eq", "2026-09-01", "Not A Zone");
            Assert.Empty(PushdownChecks.Check(model, new Kinds("sample_duedate", DateColumnKind.CalendarDate)));
        }

        private static (RuleForValidation model, RuleCondition cond) AnchoredModel(string anchorNode)
        {
            var rootId = Guid.NewGuid();
            var cond = RowCount();
            var node = anchorNode == "root" ? "\"" + rootId + "\"" : "null";
            var filter = new NodeFilterGroup
            {
                TableConfigNodeId = NodeId,
                RuleConditionId = cond.Id,
                LogicalOperator = LogicalOperator.And,
                Criteria =
                {
                    new NodeFilterCriterion
                    {
                        Kind = CriterionKind.Comparison, FieldName = "createdon", Operator = "gt",
                        ValueSource = ComparisonValueSource.DateExpression,
                        Value = "{\"anchor\":{\"kind\":\"field\",\"node\":" + node + ",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":30,\"unit\":\"days\"}",
                    },
                },
            };
            var model = Model(filter, cond);
            model.Configs = TestTree.RawTree(
                new TableConfig { Id = rootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = NodeId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_orderid", ParentTableId = rootId });
            return (model, cond);
        }

        [Fact]
        public void Root_anchored_date_filter_raises_no_warning()
        {
            var (model, _) = AnchoredModel("root");
            Assert.DoesNotContain(PushdownChecks.Check(model), i => i.Code == PushdownChecks.CodePushdownResidual);
        }

        [Fact]
        public void Row_anchored_date_filter_still_warns()
        {
            var (model, _) = AnchoredModel("row");
            Assert.Contains(PushdownChecks.Check(model), i => i.Code == PushdownChecks.CodePushdownResidual);
        }
    }
}
