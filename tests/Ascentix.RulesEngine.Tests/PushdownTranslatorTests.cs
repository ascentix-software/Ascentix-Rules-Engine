using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// The filter-pushdown translator: FetchXML goldens per operator, the partition rule
    /// (AND-subset / all-or-nothing OR), negative-operator OR-null widening, SQL LIKE wildcard
    /// escaping, and the no-drop property. Soundness contract: pushed output may only ever be a
    /// superset-returning relaxation of the in-memory filter.
    /// </summary>
    public class PushdownTranslatorTests
    {
        private static NodeFilterCriterion Crit(string field, string op, string value = null,
            ComparisonValueSource src = ComparisonValueSource.Literal, Guid? refNode = null, string refCol = null)
            => new NodeFilterCriterion
            {
                Kind = CriterionKind.Comparison,
                FieldName = field,
                Operator = op,
                Value = value,
                ValueSource = src,
                ComparisonValueNodeId = refNode,
                ComparisonValueColumn = refCol,
            };

        private static NodeFilterGroup And(params NodeFilterCriterion[] crits)
            => new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = crits.ToList() };

        private static NodeFilterGroup Or(params NodeFilterCriterion[] crits)
            => new NodeFilterGroup { LogicalOperator = LogicalOperator.Or, Criteria = crits.ToList() };

        // ── operator goldens ────────────────────────────────────────────────────────────────

        [Theory]
        [InlineData("eq", "eq")]
        [InlineData("gt", "gt")]
        [InlineData("ge", "ge")]
        [InlineData("lt", "lt")]
        [InlineData("le", "le")]
        public void Positive_scalar_operators_push_directly(string token, string fetchOp)
        {
            var r = new PushdownTranslator().Translate(And(Crit("statuscode", token, "5")));
            Assert.False(r.HasResidual);
            Assert.Equal($"<filter type='and'><condition attribute='statuscode' operator='{fetchOp}' value='5' /></filter>",
                r.Pushed.ToFetchXml());
        }

        [Fact]
        public void Null_operators_push_without_value()
        {
            var r = new PushdownTranslator().Translate(And(Crit("emailaddress1", "null"), Crit("firstname", "not-null")));
            Assert.False(r.HasResidual);
            Assert.Equal("<filter type='and'>" +
                "<condition attribute='emailaddress1' operator='null' />" +
                "<condition attribute='firstname' operator='not-null' /></filter>",
                r.Pushed.ToFetchXml());
        }

        [Fact]
        public void Ne_with_exact_literal_is_widened_with_an_or_null_arm()
        {
            // SQL three-valued logic drops null rows from `ne`; the in-memory evaluator keeps
            // them. The widened form is a superset either way; memory decides.
            var r = new PushdownTranslator().Translate(And(Crit("statuscode", "ne", "100")));
            Assert.False(r.HasResidual);
            Assert.Equal("<filter type='and'><filter type='or'>" +
                "<condition attribute='statuscode' operator='ne' value='100' />" +
                "<condition attribute='statuscode' operator='null' /></filter></filter>",
                r.Pushed.ToFetchXml());
        }

        [Fact]
        public void Ne_and_ranges_with_string_literals_are_refused_collation_narrowing()
        {
            // On an accent-insensitive org, server `ne 'Alpha'` excludes
            // 'Älpha', a row the ordinal in-memory authority matches: a narrowing no
            // re-application can recover. String-literal ne/ranges stay in memory.
            foreach (var op in new[] { "ne", "gt", "ge", "lt", "le" })
            {
                var r = new PushdownTranslator().Translate(And(Crit("lastname", op, "Smith")));
                Assert.True(r.HasResidual);
                Assert.Null(r.Pushed);
            }
        }

        [Fact]
        public void Eq_with_string_literal_still_pushes_superset_is_sound()
        {
            // Collation can only WIDEN eq (case-fold ⊆ collation-fold); re-application refines.
            var r = new PushdownTranslator().Translate(And(Crit("lastname", "eq", "Älpha")));
            Assert.False(r.HasResidual);
            Assert.Contains("operator='eq' value='Älpha'", r.Pushed.ToFetchXml());
        }

        // ── date literals ───────────────────────────────────────────────────────────────────

        [Theory]
        [InlineData("ge", "2026-09-01", "2026-08-31T00:00:00Z")]
        [InlineData("gt", "2026-09-01T10:30:00", "2026-08-31T10:30:00Z")]
        [InlineData("le", "2026-09-01", "2026-09-02T00:00:00Z")]
        [InlineData("lt", "2026-09-01T10:30:00-04:00", "2026-09-02T14:30:00Z")]
        public void Date_literal_ranges_push_a_widened_utc_literal(string op, string literal, string expected)
        {
            var r = new PushdownTranslator().Translate(And(Crit("sample_shippedon", op, literal)));
            Assert.False(r.HasResidual);
            Assert.Equal($"<filter type='and'><condition attribute='sample_shippedon' operator='{op}' value='{expected}' /></filter>",
                r.Pushed.ToFetchXml());
        }

        [Fact]
        public void Date_literal_ne_stays_in_memory()
        {
            var r = new PushdownTranslator().Translate(And(Crit("modifiedon", "ne", "2026-01-01")));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        // Exact date equality depends on the column's date behavior (Date Only compares calendar
        // dates, User Local reads an offset-less literal in the caller's zone), so without that
        // metadata no eq literal is a guaranteed superset: every date-like eq stays in memory.
        [Theory]
        [InlineData("2026-06-15T10:30:45")]
        [InlineData("2026-06-15")]
        [InlineData("2026-06-15T10:30:45Z")]
        [InlineData("2026-09-01T19:00:00-05:00")]
        [InlineData("09-01-2026")]
        public void Date_literal_eq_stays_in_memory(string literal)
        {
            var r = new PushdownTranslator().Translate(And(Crit("sample_shippedon", "eq", literal)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Theory]
        [InlineData("09-01-2026", false)]
        [InlineData("2026-09-01", false)]
        [InlineData("2026-09-01T10:30:00", false)]
        [InlineData("2026-09-01T10:30:00Z", true)]
        [InlineData("2026-09-01T19:00:00-05:00", true)]
        [InlineData("2026-09-01T19:00:00+0530", true)]
        public void Date_literal_reports_an_instant_only_for_a_trailing_zone(string literal, bool expected)
        {
            Assert.True(PushedDateLiteral.TryParse(literal, out _, out var isInstant));
            Assert.Equal(expected, isInstant);
        }

        [Theory]
        [InlineData("09-01-2026", "2026-09-01T00:00:00Z")]
        [InlineData("2026-09-01T10:30:00", "2026-09-01T10:30:00Z")]
        [InlineData("2026-09-01T19:00:00-05:00", "2026-09-02T00:00:00Z")]
        [InlineData("2026-09-01T19:00:00+0530", "2026-09-01T13:30:00Z")]
        public void Date_literal_value_is_utc(string literal, string expected)
        {
            Assert.True(PushedDateLiteral.TryParse(literal, out var value, out _));
            Assert.Equal(DateTimeKind.Utc, value.Kind);
            Assert.Equal(expected, value.ToString(PushedDateLiteral.Format, System.Globalization.CultureInfo.InvariantCulture));
        }

        [Fact]
        public void Numeric_literals_are_not_read_as_dates()
        {
            var r = new PushdownTranslator().Translate(And(Crit("sample_qty", "ge", "20260901")));
            Assert.Contains("operator='ge' value='20260901'", r.Pushed.ToFetchXml());
        }

        [Fact]
        public void Contains_pushes_as_substring_like_with_wildcards_escaped()
        {
            // In-memory contains/like are ordinal-substring (IndexOf). The pushed pattern must
            // treat the value as literal text, so SQL LIKE metacharacters are bracket-escaped.
            var r = new PushdownTranslator().Translate(And(Crit("description", "contains", "50%_[x]")));
            Assert.False(r.HasResidual);
            var xml = r.Pushed.ToFetchXml();
            Assert.Contains("operator='like' value='%50[%][_][[]x]%'", xml);
        }

        [Fact]
        public void Not_contains_is_widened_and_escaped()
        {
            var r = new PushdownTranslator().Translate(And(Crit("description", "not-contains", "a_b")));
            Assert.Equal("<filter type='and'><filter type='or'>" +
                "<condition attribute='description' operator='not-like' value='%a[_]b%' />" +
                "<condition attribute='description' operator='null' /></filter></filter>",
                r.Pushed.ToFetchXml());
        }

        [Fact]
        public void Multiselect_contains_pushes_contain_values()
        {
            var t = new PushdownTranslator(isMultiSelectColumn: col => col == "asx_channels");
            var r = t.Translate(And(Crit("asx_channels", "contains", "1, 3")));
            Assert.False(r.HasResidual);
            Assert.Equal("<filter type='and'><condition attribute='asx_channels' operator='contain-values'>" +
                "<value>1</value><value>3</value></condition></filter>",
                r.Pushed.ToFetchXml());
        }

        [Fact]
        public void Multiselect_eq_is_refused_exact_set_is_phase_2()
        {
            var t = new PushdownTranslator(isMultiSelectColumn: _ => true);
            var r = t.Translate(And(Crit("asx_channels", "eq", "1,3")));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Values_are_xml_escaped()
        {
            var r = new PushdownTranslator().Translate(And(Crit("name", "eq", "A & B <Ltd>")));
            Assert.Contains("value='A &amp; B &lt;Ltd&gt;'", r.Pushed.ToFetchXml());
        }

        // ── refusals ────────────────────────────────────────────────────────────────────────

        [Fact]
        public void Exists_criteria_are_refused()
        {
            var g = And(Crit("firstname", "eq", "x"));
            g.Criteria.Add(new NodeFilterCriterion { Kind = CriterionKind.Exists, CollectionNodeId = Guid.NewGuid() });
            var r = new PushdownTranslator().Translate(g);
            Assert.True(r.HasResidual);
            Assert.Contains("firstname", r.Pushed.ToFetchXml()); // the pushable conjunct still pushes
        }

        [Fact]
        public void Unknown_operator_is_refused_not_guessed()
        {
            var r = new PushdownTranslator().Translate(And(Crit("a", "begins-with", "x")));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Template_and_dateexpr_sources_are_refused_in_phase_1()
        {
            var r = new PushdownTranslator().Translate(And(
                Crit("a", "eq", "{root.x}", ComparisonValueSource.Template),
                Crit("b", "eq", "{}", ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Field_reference_resolves_to_literal_or_is_refused()
        {
            var node = Guid.NewGuid();
            TryResolveReferenceLiteral resolve = (Guid? n, string col, out string lit) =>
            {
                lit = n == node && col == "sample_region" ? "West" : null;
                return lit != null;
            };
            var t = new PushdownTranslator(resolve);

            var ok = t.Translate(And(Crit("region", "eq", null, ComparisonValueSource.FieldReference, node, "sample_region")));
            Assert.False(ok.HasResidual);
            Assert.Contains("operator='eq' value='West'", ok.Pushed.ToFetchXml());

            var bad = t.Translate(And(Crit("region", "eq", null, ComparisonValueSource.FieldReference, Guid.NewGuid(), "other")));
            Assert.True(bad.HasResidual);
            Assert.Null(bad.Pushed);
        }

        // ── the partition rule ──────────────────────────────────────────────────────────────

        [Fact]
        public void And_group_pushes_the_translatable_subset_and_flags_residual()
        {
            var g = And(Crit("a", "eq", "1"), Crit("b", "begins-with", "x"), Crit("c", "gt", "5"));
            var r = new PushdownTranslator().Translate(g);
            Assert.True(r.HasResidual);
            var xml = r.Pushed.ToFetchXml();
            Assert.Contains("attribute='a'", xml);
            Assert.Contains("attribute='c'", xml);
            Assert.DoesNotContain("attribute='b'", xml);
        }

        [Fact]
        public void Or_group_with_any_unpushable_disjunct_pushes_nothing()
        {
            // Pushing half an OR would narrow the result, which is strictly forbidden.
            var g = Or(Crit("a", "eq", "1"), Crit("b", "begins-with", "x"));
            var r = new PushdownTranslator().Translate(g);
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Fully_pushable_or_group_pushes_whole()
        {
            var r = new PushdownTranslator().Translate(Or(Crit("a", "eq", "1"), Crit("b", "null")));
            Assert.False(r.HasResidual);
            Assert.Equal("<filter type='or'>" +
                "<condition attribute='a' operator='eq' value='1' />" +
                "<condition attribute='b' operator='null' /></filter>",
                r.Pushed.ToFetchXml());
        }

        [Fact]
        public void Nested_or_child_with_unpushable_member_is_dropped_whole_from_and_parent()
        {
            var parent = And(Crit("top", "eq", "1"));
            parent.ChildGroups.Add(Or(Crit("x", "eq", "2"), Crit("y", "begins-with", "z")));
            var r = new PushdownTranslator().Translate(parent);
            Assert.True(r.HasResidual);
            var xml = r.Pushed.ToFetchXml();
            Assert.Contains("attribute='top'", xml);
            Assert.DoesNotContain("attribute='x'", xml); // no half-OR fragment leaked through
        }

        [Fact]
        public void Nested_fully_pushable_child_group_nests_in_output()
        {
            var parent = And(Crit("top", "eq", "1"));
            parent.ChildGroups.Add(Or(Crit("x", "eq", "2"), Crit("y", "eq", "3")));
            var r = new PushdownTranslator().Translate(parent);
            Assert.False(r.HasResidual);
            Assert.Equal("<filter type='and'><condition attribute='top' operator='eq' value='1' />" +
                "<filter type='or'><condition attribute='x' operator='eq' value='2' />" +
                "<condition attribute='y' operator='eq' value='3' /></filter></filter>",
                r.Pushed.ToFetchXml());
        }

        // ── no-drop / soundness properties over generated trees ─────────────────────────────

        [Fact]
        public void No_drop_property_every_criterion_is_pushed_or_residual_flagged()
        {
            // Over a spread of generated trees: if HasResidual is false, every literal comparison
            // criterion must appear in the pushed XML; if any criterion was refused, HasResidual
            // must be true. (A criterion silently vanishing without the flag = the narrowing bug.)
            var rand = new Random(42);
            string[] ops = { "eq", "ne", "gt", "like", "null", "begins-with" };
            for (var i = 0; i < 200; i++)
            {
                var group = new NodeFilterGroup
                {
                    LogicalOperator = rand.Next(2) == 0 ? LogicalOperator.And : LogicalOperator.Or,
                };
                var fields = new List<string>();
                var refusable = 0;
                for (var c = 0; c < 1 + rand.Next(4); c++)
                {
                    var op = ops[rand.Next(ops.Length)];
                    var field = "f" + c;
                    fields.Add(field);
                    if (op == "begins-with") refusable++;
                    // Numeric literal so ne/gt stay pushable (string literals refuse: collation).
                    group.Criteria.Add(Crit(field, op, op == "null" ? null : "7"));
                }

                var r = new PushdownTranslator().Translate(group);
                if (refusable > 0)
                {
                    Assert.True(r.HasResidual);
                    if (group.LogicalOperator == LogicalOperator.Or) Assert.Null(r.Pushed);
                }
                else
                {
                    Assert.False(r.HasResidual);
                    var xml = r.Pushed.ToFetchXml();
                    foreach (var f in fields) Assert.Contains($"attribute='{f}'", xml);
                }
            }
        }

        // ── search-criteria overload + canonical key ────────────────────────────────────────

        [Fact]
        public void Search_criteria_translate_via_the_same_rules()
        {
            var r = new PushdownTranslator().Translate(new[]
            {
                new SearchCriterion { FieldName = "statuscode", Operator = "eq", Value = "1" },
                new SearchCriterion { FieldName = "name", Operator = "contains", Value = "vip" },
            }, LogicalOperator.And);
            Assert.False(r.HasResidual);
            var xml = r.Pushed.ToFetchXml();
            Assert.Contains("attribute='statuscode' operator='eq' value='1'", xml);
            Assert.Contains("operator='like' value='%vip%'", xml);
        }

        [Fact]
        public void Canonical_key_is_stable_and_distinguishes_predicates()
        {
            var a1 = new PushdownTranslator().Translate(And(Crit("a", "eq", "1"), Crit("b", "gt", "2")));
            var a2 = new PushdownTranslator().Translate(And(Crit("a", "eq", "1"), Crit("b", "gt", "2")));
            var b = new PushdownTranslator().Translate(And(Crit("a", "eq", "1"), Crit("b", "gt", "3")));

            Assert.Equal(a1.Pushed.CanonicalKey(), a2.Pushed.CanonicalKey());
            Assert.NotEqual(a1.Pushed.CanonicalKey(), b.Pushed.CanonicalKey());
        }

        // ── date expressions ────────────────────────────────────────────────────────────────

        private static readonly DateTime Now = new DateTime(2026, 9, 26, 12, 0, 0, DateTimeKind.Utc);

        private static string NowMinusDays(int d) =>
            "{\"anchor\":{\"kind\":\"now\"},\"op\":\"subtract\",\"amount\":" + d + ",\"unit\":\"days\"}";

        // now - 90d = 2026-06-28T12:00Z; the pushed literal is widened one day outward.
        [Theory]
        [InlineData("ge", "2026-06-27T12:00:00Z")]
        [InlineData("gt", "2026-06-27T12:00:00Z")]
        [InlineData("le", "2026-06-29T12:00:00Z")]
        [InlineData("lt", "2026-06-29T12:00:00Z")]
        public void Now_anchored_date_expression_pushes_a_widened_literal(string op, string expected)
        {
            var r = new PushdownTranslator(utcNow: Now).Translate(
                And(Crit("actualclosedate", op, NowMinusDays(90), ComparisonValueSource.DateExpression)));
            Assert.False(r.HasResidual);
            Assert.Equal($"<filter type='and'><condition attribute='actualclosedate' operator='{op}' value='{expected}' /></filter>",
                r.Pushed.ToFetchXml());
        }

        [Theory]
        [InlineData("eq")]
        [InlineData("ne")]
        public void Equality_date_expressions_stay_in_memory(string op)
        {
            var r = new PushdownTranslator(utcNow: Now).Translate(
                And(Crit("actualclosedate", op, NowMinusDays(1), ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Field_anchored_date_expression_stays_in_memory()
        {
            var payload = "{\"anchor\":{\"kind\":\"field\",\"node\":null,\"column\":\"estimatedclosedate\"},\"op\":\"add\",\"amount\":2,\"unit\":\"days\"}";
            var r = new PushdownTranslator(utcNow: Now).Translate(
                And(Crit("actualclosedate", "le", payload, ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Date_expression_without_an_instant_stays_in_memory()
        {
            var r = new PushdownTranslator().Translate(
                And(Crit("actualclosedate", "ge", NowMinusDays(1), ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Pushed_literal_never_narrows_at_the_boundary()
        {
            // A row exactly at now-90d passes "le now-90d" in memory; the pushed "le" literal must
            // be at or after it so the server returns the row.
            var boundary = Now.AddDays(-90);
            var r = new PushdownTranslator(utcNow: Now).Translate(
                And(Crit("actualclosedate", "le", NowMinusDays(90), ComparisonValueSource.DateExpression)));
            var pushed = DateTime.Parse(r.Pushed.Conditions[0].Value, null, System.Globalization.DateTimeStyles.AdjustToUniversal);
            Assert.True(pushed >= boundary);
        }

        [Theory]
        [InlineData("ge")]
        [InlineData("le")]
        public void Out_of_range_date_expression_is_refused_not_thrown(string op)
        {
            // now - 20000 years is before DateTime.MinValue: the push is refused, never thrown.
            var r = new PushdownTranslator(utcNow: Now).Translate(
                And(Crit("actualclosedate", op, "{\"anchor\":{\"kind\":\"now\"},\"op\":\"subtract\",\"amount\":20000,\"unit\":\"years\"}", ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Widening_past_the_calendar_edge_is_refused_not_thrown()
        {
            // The expression itself lands in range; widening it one day outward would not.
            var nearMax = new DateTime(9999, 12, 31, 12, 0, 0, DateTimeKind.Utc);
            var r = new PushdownTranslator(utcNow: nearMax).Translate(
                And(Crit("actualclosedate", "le", "{\"anchor\":{\"kind\":\"now\"},\"op\":\"add\",\"amount\":1,\"unit\":\"minutes\"}", ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        // ── anchored date placeholders ──────────────────────────────────────────────────────

        private static readonly Guid AnchorNode = Guid.Parse("11111111-1111-1111-1111-111111111111");

        private static string AnchorPlus(int days) =>
            "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + AnchorNode + "\",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":" + days + ",\"unit\":\"days\"}";

        private static PushdownTranslator Binding() => new PushdownTranslator(utcNow: Now, canBindAnchor: id => id == AnchorNode);

        [Fact]
        public void Bindable_anchor_pushes_a_placeholder()
        {
            var r = Binding().Translate(And(Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));

            Assert.False(r.HasResidual);
            Assert.True(r.Pushed.HasBindings);
            var c = Assert.Single(r.Pushed.Conditions);
            Assert.Equal("createdon", c.Attribute);
            Assert.Equal("gt", c.Operator);
            Assert.Null(c.Value);
            Assert.Equal(AnchorPlus(30), c.Binding.Payload);
        }

        [Fact]
        public void Placeholder_key_does_not_depend_on_the_bound_value()
        {
            var a = Binding().Translate(And(Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var b = Binding().Translate(And(Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var other = Binding().Translate(And(Crit("createdon", "gt", AnchorPlus(31), ComparisonValueSource.DateExpression)));

            Assert.Equal(a.Pushed.CanonicalKey(), b.Pushed.CanonicalKey());
            Assert.NotEqual(a.Pushed.CanonicalKey(), other.Pushed.CanonicalKey());
        }

        [Fact]
        public void Unbindable_anchor_stays_in_memory()
        {
            var r = new PushdownTranslator(utcNow: Now, canBindAnchor: _ => false)
                .Translate(And(Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Theory]
        [InlineData("eq")]
        [InlineData("ne")]
        public void Equality_anchored_expressions_stay_in_memory(string op)
        {
            var r = Binding().Translate(And(Crit("createdon", op, AnchorPlus(30), ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Bind_fills_every_placeholder()
        {
            var r = Binding().Translate(And(
                Crit("statuscode", "eq", "1"),
                Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));

            var bound = r.Pushed.Bind(b => "2026-09-30T00:00:00Z");

            Assert.False(bound.HasBindings);
            Assert.Equal("<filter type='and'><condition attribute='statuscode' operator='eq' value='1' />" +
                "<condition attribute='createdon' operator='gt' value='2026-09-30T00:00:00Z' /></filter>", bound.ToFetchXml());
        }

        // An unbindable placeholder (missing anchor record or value) is dropped, not the filter:
        // dropping a conjunct only widens an AND, and an OR with an unbounded member is itself
        // unbounded, so it leaves its AND parent whole. Memory re-applies the full filter.
        [Fact]
        public void Bind_drops_an_unbindable_placeholder_and_keeps_the_other_conjuncts()
        {
            var r = Binding().Translate(And(
                Crit("statuscode", "eq", "1"),
                Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));

            var bound = r.Pushed.Bind(_ => null);

            Assert.Equal("<filter type='and'><condition attribute='statuscode' operator='eq' value='1' /></filter>",
                bound.ToFetchXml());
        }

        [Fact]
        public void Bind_keeps_the_placeholders_that_bind()
        {
            var r = Binding().Translate(And(
                Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression),
                Crit("modifiedon", "lt", AnchorPlus(31), ComparisonValueSource.DateExpression)));

            var bound = r.Pushed.Bind(b => b.Payload == AnchorPlus(30) ? "2026-09-30T00:00:00Z" : null);

            Assert.Equal("<filter type='and'><condition attribute='createdon' operator='gt' value='2026-09-30T00:00:00Z' /></filter>",
                bound.ToFetchXml());
        }

        [Fact]
        public void Bind_drops_an_or_group_with_an_unbindable_member_and_keeps_its_and_siblings()
        {
            var group = And(Crit("statuscode", "eq", "1"));
            group.ChildGroups.Add(Or(
                Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression),
                Crit("statecode", "eq", "0")));
            var r = Binding().Translate(group);
            Assert.False(r.HasResidual);

            var bound = r.Pushed.Bind(_ => null);

            Assert.Equal("<filter type='and'><condition attribute='statuscode' operator='eq' value='1' /></filter>",
                bound.ToFetchXml());
        }

        [Fact]
        public void Bind_relaxes_an_and_group_inside_an_or_instead_of_dropping_the_or()
        {
            var inner = And(
                Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression),
                Crit("statecode", "eq", "0"));
            var group = Or(Crit("statuscode", "eq", "1"));
            group.ChildGroups.Add(inner);
            var r = Binding().Translate(group);
            Assert.False(r.HasResidual);

            var bound = r.Pushed.Bind(_ => null);

            Assert.Equal("<filter type='or'><condition attribute='statuscode' operator='eq' value='1' />" +
                "<filter type='and'><condition attribute='statecode' operator='eq' value='0' /></filter></filter>",
                bound.ToFetchXml());
        }

        [Fact]
        public void Bind_returns_null_when_nothing_bounded_is_left()
        {
            var and = Binding().Translate(And(Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var or = Binding().Translate(Or(
                Crit("statuscode", "eq", "1"),
                Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));

            Assert.Null(and.Pushed.Bind(_ => null));
            Assert.Null(or.Pushed.Bind(_ => null));
        }

        [Fact]
        public void Unbound_placeholder_cannot_serialize()
        {
            var r = Binding().Translate(And(Crit("createdon", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            Assert.Throws<InvalidOperationException>(() => r.Pushed.ToFetchXml());
        }

        [Theory]
        [InlineData("null")]
        [InlineData("not-null")]
        public void Valueless_operators_push_whatever_the_value_source(string op)
        {
            var r = new PushdownTranslator().Translate(And(Crit("createdon", op, AnchorPlus(1), ComparisonValueSource.DateExpression)));
            Assert.False(r.HasResidual);
            Assert.Equal($"<filter type='and'><condition attribute='createdon' operator='{op}' /></filter>", r.Pushed.ToFetchXml());
        }

        // ── exact values for a known column behavior ────────────────────────────────────────

        private static readonly TimeZoneInfo Eastern = TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");

        private static PushdownTranslator Exact(DateColumnKind kind, TimeZoneInfo zone = null, DateTime? now = null) =>
            new PushdownTranslator(utcNow: now ?? Now, canBindAnchor: id => id == AnchorNode, dateKindOf: _ => kind, zone: zone);

        [Theory]
        [InlineData(DateColumnKind.Instant, "ge", "2026-09-01", "2026-09-01T04:00:00Z")]            // Eastern midnight
        [InlineData(DateColumnKind.CalendarDate, "lt", "2026-09-01T02:00:00Z", "2026-08-31")]       // 22:00 EDT on Aug 31
        [InlineData(DateColumnKind.WallClock, "gt", "2026-09-01T04:30:00Z", "2026-09-01T00:30:00")]
        public void Known_behavior_pushes_an_exact_value(DateColumnKind kind, string op, string literal, string expected)
        {
            var r = Exact(kind, Eastern).Translate(And(Crit("d", op, literal)));
            Assert.False(r.HasResidual);
            Assert.Equal($"<filter type='and'><condition attribute='d' operator='{op}' value='{expected}' /></filter>", r.Pushed.ToFetchXml());
        }

        [Fact]
        public void Known_behavior_pushes_ne_with_the_null_arm()
        {
            var xml = Exact(DateColumnKind.Instant).Translate(And(Crit("d", "ne", "2026-09-01T00:00:00Z"))).Pushed.ToFetchXml();
            Assert.Equal("<filter type='and'><filter type='or'><condition attribute='d' operator='ne' value='2026-09-01T00:00:00Z' />" +
                "<condition attribute='d' operator='null' /></filter></filter>", xml);
        }

        // ── Date Only: half-open day ranges ─────────────────────────────────────────────────
        //
        // Memory compares the stored value's calendar date (field.Date). A stored value can carry
        // a time part (a column whose behavior changed without ConvertDateAndTimeBehavior), and
        // the server may compare it against the literal's midnight, so `le D` / `eq D` pushed as
        // a single `D` value would drop "D 10:00". Ranges on day boundaries mean the same thing
        // whether the server compares dates or date-times.

        private const string DayAnd = "<filter type='and'>";

        [Theory]
        [InlineData("eq", DayAnd + "<filter type='and'><condition attribute='d' operator='ge' value='2026-09-01' /><condition attribute='d' operator='lt' value='2026-09-02' /></filter></filter>")]
        [InlineData("ne", DayAnd + "<filter type='or'><condition attribute='d' operator='lt' value='2026-09-01' /><condition attribute='d' operator='ge' value='2026-09-02' /><condition attribute='d' operator='null' /></filter></filter>")]
        [InlineData("le", DayAnd + "<condition attribute='d' operator='lt' value='2026-09-02' /></filter>")]
        [InlineData("lt", DayAnd + "<condition attribute='d' operator='lt' value='2026-09-01' /></filter>")]
        [InlineData("gt", DayAnd + "<condition attribute='d' operator='ge' value='2026-09-02' /></filter>")]
        [InlineData("ge", DayAnd + "<condition attribute='d' operator='ge' value='2026-09-01' /></filter>")]
        public void Date_only_literal_pushes_a_half_open_day_range(string op, string expected)
        {
            var r = Exact(DateColumnKind.CalendarDate).Translate(And(Crit("d", op, "2026-09-01")));
            Assert.False(r.HasResidual);
            Assert.Equal(expected, r.Pushed.ToFetchXml());
        }

        [Fact]
        public void Date_only_instant_literal_takes_its_day_in_the_zone()
        {
            // 2026-09-01T02:00Z is 22:00 EDT on Aug 31.
            var xml = Exact(DateColumnKind.CalendarDate, Eastern).Translate(And(Crit("d", "eq", "2026-09-01T02:00:00Z"))).Pushed.ToFetchXml();
            Assert.Contains("operator='ge' value='2026-08-31'", xml);
            Assert.Contains("operator='lt' value='2026-09-01'", xml);
        }

        [Fact]
        public void Date_only_now_pushes_a_half_open_day_range()
        {
            // now - 1d = 2026-09-25T12:00Z: Sep 25 in Eastern.
            var xml = Exact(DateColumnKind.CalendarDate, Eastern)
                .Translate(And(Crit("d", "le", NowMinusDays(1), ComparisonValueSource.DateExpression))).Pushed.ToFetchXml();
            Assert.Equal(DayAnd + "<condition attribute='d' operator='lt' value='2026-09-26' /></filter>", xml);
        }

        [Theory]
        [InlineData("eq", false)]
        [InlineData("ne", false)]
        [InlineData("le", false)]
        [InlineData("gt", false)]
        [InlineData("lt", true)]
        [InlineData("ge", true)]
        public void Date_only_day_after_the_calendar_is_refused(string op, bool pushes)
        {
            var r = Exact(DateColumnKind.CalendarDate).Translate(And(Crit("d", op, "9999-12-31")));
            Assert.Equal(!pushes, r.HasResidual);
            Assert.Equal(pushes, r.Pushed != null);
        }

        [Fact]
        public void Date_only_placeholder_binds_a_half_open_day_range()
        {
            var eq = Exact(DateColumnKind.CalendarDate, Eastern).Translate(And(Crit("d", "eq", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var ne = Exact(DateColumnKind.CalendarDate, Eastern).Translate(And(Crit("d", "ne", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var anchor = new DateTime(2026, 9, 1, 2, 0, 0, DateTimeKind.Utc);   // Aug 31 in Eastern

            Assert.Equal(DayAnd + "<condition attribute='d' operator='ge' value='2026-08-31' /><condition attribute='d' operator='lt' value='2026-09-01' /></filter>",
                eq.Pushed.Bind(b => b.Format(anchor)).ToFetchXml());
            Assert.Equal(DayAnd + "<filter type='or'><condition attribute='d' operator='lt' value='2026-08-31' /><condition attribute='d' operator='ge' value='2026-09-01' /><condition attribute='d' operator='null' /></filter></filter>",
                ne.Pushed.Bind(b => b.Format(anchor)).ToFetchXml());
        }

        [Fact]
        public void Date_only_placeholder_key_is_the_same_for_every_root()
        {
            var a = Exact(DateColumnKind.CalendarDate).Translate(And(Crit("d", "eq", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var b = Exact(DateColumnKind.CalendarDate).Translate(And(Crit("d", "eq", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            Assert.Equal(a.Pushed.CanonicalKey(), b.Pushed.CanonicalKey());
        }

        // A day range that cannot be built relaxes like any unbindable placeholder: dropped from
        // an AND, and the OR holding it drops out whole.
        [Fact]
        public void Date_only_placeholder_past_the_calendar_relaxes()
        {
            var maxDay = new DateTime(9999, 12, 31, 0, 0, 0, DateTimeKind.Unspecified);
            var and = Exact(DateColumnKind.CalendarDate).Translate(And(
                Crit("statuscode", "eq", "1"),
                Crit("d", "le", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var group = And(Crit("statuscode", "eq", "1"));
            group.ChildGroups.Add(Or(
                Crit("d", "eq", AnchorPlus(30), ComparisonValueSource.DateExpression),
                Crit("statecode", "eq", "0")));
            var or = new PushdownTranslator(utcNow: Now, canBindAnchor: id => id == AnchorNode,
                dateKindOf: c => c == "d" ? DateColumnKind.CalendarDate : (DateColumnKind?)null).Translate(group);

            Assert.Equal("<filter type='and'><condition attribute='statuscode' operator='eq' value='1' /></filter>",
                and.Pushed.Bind(b => b.Format(maxDay)).ToFetchXml());
            Assert.Equal("<filter type='and'><condition attribute='statuscode' operator='eq' value='1' /></filter>",
                or.Pushed.Bind(b => b.Format(maxDay)).ToFetchXml());
        }

        [Fact]
        public void Now_with_a_fraction_rounds_toward_the_kept_rows()
        {
            var now = new DateTime(2026, 9, 27, 12, 0, 0, DateTimeKind.Utc).AddMilliseconds(500);
            string Push(string op) => Exact(DateColumnKind.Instant, now: now)
                .Translate(And(Crit("d", op, NowMinusDays(1), ComparisonValueSource.DateExpression))).Pushed?.ToFetchXml();

            Assert.Contains("value='2026-09-26T12:00:01Z'", Push("lt"));
            Assert.Contains("value='2026-09-26T12:00:00Z'", Push("ge"));
            Assert.Null(Push("ne"));
        }

        [Fact]
        public void Known_behavior_placeholder_formats_exactly()
        {
            var r = Exact(DateColumnKind.CalendarDate, Eastern).Translate(And(Crit("d", "eq", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var c = Assert.Single(r.Pushed.Conditions);
            Assert.Equal("2026-08-31", c.Binding.Format(new DateTime(2026, 9, 1, 2, 0, 0, DateTimeKind.Utc)));
        }

        [Fact]
        public void Placeholder_reads_a_local_value_as_the_instant_memory_reads()
        {
            // Memory reads the anchor through its "o" string, where a local value carries an offset.
            var r = Exact(DateColumnKind.CalendarDate, Eastern).Translate(And(Crit("d", "eq", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var binding = Assert.Single(r.Pushed.Conditions).Binding;
            var local = new DateTime(2026, 9, 1, 2, 0, 0, DateTimeKind.Local);
            Assert.Equal(binding.Format(local.ToUniversalTime()), binding.Format(local));
        }

        // The binder reads the anchor the way memory does: by the anchor column's behavior when
        // metadata knows it, otherwise by the value's DateTimeKind (see DateSemanticsTests).
        [Fact]
        public void Placeholder_reads_the_anchor_by_its_columns_behavior()
        {
            var sdkUtc = new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc);   // a Date Only value, Utc-kinded
            DateBinding Bind(DateColumnKind? anchorKind) => Assert.Single(new PushdownTranslator(utcNow: Now,
                    canBindAnchor: id => id == AnchorNode, dateKindOf: _ => DateColumnKind.Instant, zone: Eastern,
                    anchorKindOf: (node, column) => node == AnchorNode && column == "createdon" ? anchorKind : null)
                .Translate(And(Crit("d", "ge", AnchorPlus(1), ComparisonValueSource.DateExpression))).Pushed.Conditions).Binding;
            var anchorPlusOneDay = sdkUtc.AddDays(1);   // what the executor evaluates: Sep 2, still Utc-kinded

            Assert.Equal("2026-09-02T04:00:00Z", Bind(DateColumnKind.CalendarDate).Format(anchorPlusOneDay));   // Sep 2 midnight, Eastern
            Assert.Equal("2026-09-02T04:00:00Z", Bind(DateColumnKind.WallClock).Format(anchorPlusOneDay));
            Assert.Equal("2026-09-02T00:00:00Z", Bind(DateColumnKind.Instant).Format(DateTime.SpecifyKind(anchorPlusOneDay, DateTimeKind.Unspecified)));
            Assert.Equal("2026-09-02T00:00:00Z", Bind(null).Format(anchorPlusOneDay));   // fallback: the Kind decides
        }

        [Fact]
        public void Placeholder_key_includes_the_zone()
        {
            var eastern = Exact(DateColumnKind.Instant, Eastern).Translate(And(Crit("d", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var utc = Exact(DateColumnKind.Instant, TimeZoneInfo.Utc).Translate(And(Crit("d", "gt", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            Assert.NotEqual(eastern.Pushed.CanonicalKey(), utc.Pushed.CanonicalKey());
        }

        // Ruling 2: metadata says the column is not a date, so a date-looking literal is not
        // reformatted as one (a text column compares strings; memory decides).
        [Fact]
        public void Known_non_date_column_takes_no_date_path()
        {
            var r = new PushdownTranslator(dateKindOf: _ => null).Translate(And(Crit("sample_notes", "ge", "2026-09-01")));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Known_non_date_column_keeps_date_expressions_in_memory()
        {
            var r = new PushdownTranslator(utcNow: Now, dateKindOf: _ => null)
                .Translate(And(Crit("sample_notes", "ge", NowMinusDays(1), ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Known_behavior_pushes_now_exactly_including_equality()
        {
            // now - 1d = 2026-09-25T12:00Z = 08:00 EDT on Sep 25.
            string Push(DateColumnKind kind, string op) => Exact(kind, Eastern)
                .Translate(And(Crit("d", op, NowMinusDays(1), ComparisonValueSource.DateExpression))).Pushed?.ToFetchXml();

            Assert.Contains("operator='eq' value='2026-09-25T12:00:00Z'", Push(DateColumnKind.Instant, "eq"));
            Assert.Contains("operator='ge' value='2026-09-25' /><condition attribute='d' operator='lt' value='2026-09-26'", Push(DateColumnKind.CalendarDate, "eq"));
            Assert.Contains("operator='ne' value='2026-09-25T08:00:00'", Push(DateColumnKind.WallClock, "ne"));
        }

        // Only comparison operators take the date path: `not-like` would push without its OR-null
        // arm (memory keeps null rows) and an unknown token would emit invalid FetchXML.
        [Theory]
        [InlineData("not-like")]
        [InlineData("like")]
        [InlineData("contains")]
        [InlineData("not-contains")]
        [InlineData("begins-with")]
        public void Known_behavior_now_with_a_non_comparison_operator_stays_in_memory(string op)
        {
            var r = Exact(DateColumnKind.Instant).Translate(And(Crit("d", op, NowMinusDays(1), ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Known_behavior_placeholder_ne_gains_the_null_arm()
        {
            var r = Exact(DateColumnKind.Instant).Translate(And(Crit("d", "ne", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            var or = Assert.Single(r.Pushed.Children);
            Assert.Equal(LogicalOperator.Or, or.Op);
            Assert.NotNull(or.Conditions[0].Binding);
            Assert.Equal("null", or.Conditions[1].Operator);
        }

        [Fact]
        public void Unknown_behavior_placeholder_equality_stays_in_memory()
        {
            var r = Binding().Translate(And(Crit("d", "eq", AnchorPlus(30), ComparisonValueSource.DateExpression)));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }

        [Fact]
        public void Exact_value_leaving_the_calendar_is_refused_not_thrown()
        {
            // 0001-01-01 00:00 in Tokyo (UTC+9) is before DateTime.MinValue in UTC.
            var tokyo = TimeZoneInfo.FindSystemTimeZoneById("Tokyo Standard Time");
            var r = Exact(DateColumnKind.Instant, tokyo).Translate(And(Crit("d", "ge", "0001-01-01T00:00:00")));
            Assert.True(r.HasResidual);
            Assert.Null(r.Pushed);
        }
    }
}
