using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// NodeFilterCriterion.ValueSource == DateExpression: the RHS is "now ± N units", a date on
    /// the filtered row ± N units, or a date on a single-cardinality node ± N units.
    /// </summary>
    public class NodeFilterDateExpressionTests
    {
        private static readonly DateTime Now = new DateTime(2026, 9, 26, 12, 0, 0, DateTimeKind.Utc);
        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid ContactId = Guid.NewGuid();
        private static readonly Guid OppId = Guid.NewGuid();
        private static readonly Guid AccountRecordId = Guid.NewGuid();

        private static NodeFilterEvaluator Setup(List<Entity> opportunities = null, DateTime? contactDate = null, bool noContact = false)
        {
            var tree = TestTree.Tree(
                new TableConfig { Id = RootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = ContactId, TableLogicalName = "contact", ConfigType = TableConfigType.LookupTable,
                    ParentTableId = RootId, LookupColumnLogicalName = "primarycontactid" },
                new TableConfig { Id = OppId, TableLogicalName = "opportunity", ConfigType = TableConfigType.ChildTable,
                    ParentTableId = RootId, ChildLinkField = "parentaccountid" });

            var cache = new QueryResultCache();
            cache.Store(RootId, new List<Entity> { new Entity("account", AccountRecordId) });
            var contact = new Entity("contact", Guid.NewGuid());
            if (contactDate.HasValue) contact["lastusedincampaign"] = contactDate.Value;
            cache.Store(ContactId, noContact ? new List<Entity>() : new List<Entity> { contact });
            cache.Store(OppId, opportunities ?? new List<Entity>());

            var resolver = new FieldValueResolver();
            var values = new ComparisonValueResolver(cache, tree, resolver, null, Now);
            return new NodeFilterEvaluator(resolver, values, cache, tree);
        }

        private static string NowMinus(int amount, string unit = "days") =>
            "{\"anchor\":{\"kind\":\"now\"},\"op\":\"subtract\",\"amount\":" + amount + ",\"unit\":\"" + unit + "\"}";

        private static string RowPlus(string column, int days) =>
            "{\"anchor\":{\"kind\":\"field\",\"node\":null,\"column\":\"" + column + "\"},\"op\":\"add\",\"amount\":" + days + ",\"unit\":\"days\"}";

        private static string ContactPlus(int days) =>
            "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + ContactId + "\",\"column\":\"lastusedincampaign\"},"
            + "\"op\":\"add\",\"amount\":" + days + ",\"unit\":\"days\"}";

        private static NodeFilterCriterion DateCrit(string field, string op, string payload) => new NodeFilterCriterion
        {
            Kind = CriterionKind.Comparison, FieldName = field, Operator = op,
            ValueSource = ComparisonValueSource.DateExpression, Value = payload,
        };

        private static NodeFilterGroup And(params NodeFilterCriterion[] c) =>
            new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = c.ToList() };

        private static Entity Opp(params (string col, object value)[] cols)
        {
            var e = new Entity("opportunity", Guid.NewGuid()) { ["parentaccountid"] = new EntityReference("account", AccountRecordId) };
            foreach (var (col, value) in cols) e[col] = value;
            return e;
        }

        [Fact]
        public void Now_anchored_ge_keeps_rows_inside_the_window()
        {
            var eval = Setup();
            var group = And(DateCrit("actualclosedate", "ge", NowMinus(90)));

            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { Opp(("actualclosedate", Now.AddDays(-10))) }, OppId));
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { Opp(("actualclosedate", Now.AddDays(-100))) }, OppId));
        }

        [Fact]
        public void Months_unit_is_applied()
        {
            var eval = Setup();
            var group = And(DateCrit("actualclosedate", "ge", NowMinus(12, "months")));

            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { Opp(("actualclosedate", Now.AddMonths(-11))) }, OppId));
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { Opp(("actualclosedate", Now.AddMonths(-13))) }, OppId));
        }

        [Fact]
        public void Row_anchor_reads_the_filtered_row()
        {
            var eval = Setup();
            // closed no later than two days after the estimated close date
            var group = And(DateCrit("actualclosedate", "le", RowPlus("estimatedclosedate", 2)));
            var est = new DateTime(2026, 5, 1, 0, 0, 0, DateTimeKind.Utc);

            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity>
                { Opp(("estimatedclosedate", est), ("actualclosedate", est.AddDays(1))) }, OppId));
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity>
                { Opp(("estimatedclosedate", est), ("actualclosedate", est.AddDays(5))) }, OppId));
        }

        [Fact]
        public void Row_anchor_null_excludes_the_row_without_error()
        {
            var eval = Setup();
            var group = And(DateCrit("actualclosedate", "le", RowPlus("estimatedclosedate", 2)));

            // estimatedclosedate absent on the row: the criterion is false, nothing throws.
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity>
                { Opp(("actualclosedate", Now)) }, OppId));
        }

        [Fact]
        public void Node_anchor_reads_the_single_cardinality_node()
        {
            var eval = Setup(contactDate: new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc));
            var payload = "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + ContactId + "\",\"column\":\"lastusedincampaign\"},"
                        + "\"op\":\"add\",\"amount\":7,\"unit\":\"days\"}";
            var group = And(DateCrit("actualclosedate", "lt", payload)); // before contact date + 7d = 2026-09-08

            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { Opp(("actualclosedate", new DateTime(2026, 9, 5, 0, 0, 0, DateTimeKind.Utc))) }, OppId));
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { Opp(("actualclosedate", new DateTime(2026, 9, 9, 0, 0, 0, DateTimeKind.Utc))) }, OppId));
        }

        [Fact]
        public void Node_anchor_with_a_null_value_matches_no_rows()
        {
            var eval = Setup(contactDate: null);
            var group = And(DateCrit("actualclosedate", "lt", ContactPlus(7)));

            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { Opp(("actualclosedate", Now)) }, OppId));
        }

        [Fact]
        public void Empty_optional_lookup_anchor_matches_no_rows()
        {
            var eval = Setup(noContact: true);
            var group = And(DateCrit("actualclosedate", "lt", ContactPlus(7)));

            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { Opp(("actualclosedate", Now)) }, OppId));
        }

        [Fact]
        public void Valueless_operators_ignore_the_payload()
        {
            var eval = Setup();
            var group = And(DateCrit("actualclosedate", "null", NowMinus(1)));

            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { Opp() }, OppId));
        }

        [Fact]
        public void Malformed_payload_throws()
        {
            var eval = Setup();
            var group = And(DateCrit("actualclosedate", "ge", "{\"anchor\":{\"kind\":\"now\"}}"));

            Assert.Throws<InvalidPluginExecutionException>(() =>
                eval.EvaluateFilterGroup(group, new List<Entity> { Opp(("actualclosedate", Now)) }, OppId));
        }

        [Fact]
        public void Exists_sub_filter_uses_the_date_expression()
        {
            var recent = Opp(("actualclosedate", Now.AddDays(-5)));
            var old = Opp(("actualclosedate", Now.AddDays(-200)));
            var eval = Setup(new List<Entity> { recent, old });
            var exists = new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists, CollectionNodeId = OppId, MinCount = 2,
                SubFilter = And(DateCrit("actualclosedate", "ge", NowMinus(90))),
            };
            var root = new Entity("account", AccountRecordId);

            // only one opportunity closed in the last 90 days, so "at least 2" fails
            Assert.False(eval.EvaluateFilterGroup(And(exists), new List<Entity> { root }, RootId));
        }

        [Fact]
        public void Without_a_value_resolver_a_date_expression_is_a_configuration_fault()
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var group = And(DateCrit("actualclosedate", "ge", NowMinus(1)));

            Assert.Throws<InvalidPluginExecutionException>(() =>
                eval.EvaluateFilterGroup(group, new List<Entity> { Opp(("actualclosedate", Now)) }));
        }
    }
}
