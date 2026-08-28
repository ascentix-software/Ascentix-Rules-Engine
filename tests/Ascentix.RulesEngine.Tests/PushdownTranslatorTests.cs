using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
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

        [Fact]
        public void Date_literals_count_as_exact_for_ranges_and_ne()
        {
            var r = new PushdownTranslator().Translate(And(
                Crit("createdon", "gt", "2026-06-20T00:00:00Z"),
                Crit("modifiedon", "ne", "2026-01-01")));
            Assert.False(r.HasResidual);
            var xml = r.Pushed.ToFetchXml();
            Assert.Contains("operator='gt'", xml);
            Assert.Contains("operator='ne'", xml);
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
    }
}
