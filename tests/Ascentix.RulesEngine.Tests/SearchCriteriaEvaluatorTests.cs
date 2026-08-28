using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class SearchCriteriaEvaluatorTests
    {
        private static SearchCriteriaEvaluator Eval() =>
            new SearchCriteriaEvaluator(new FieldValueResolver());

        private static SearchCriterion C(string field, string op, string val) =>
            new SearchCriterion { FieldName = field, Operator = op, Value = val };

        private static SearchCriteriaGroup G(LogicalOperator op, params SearchCriterion[] crit) =>
            new SearchCriteriaGroup
            {
                Id = Guid.NewGuid(),
                LogicalOperator = op,
                Criteria = new List<SearchCriterion>(crit)
            };

        private static Entity Rec(params (string attr, object val)[] attrs)
        {
            var e = new Entity("line") { Id = Guid.NewGuid() };
            foreach (var a in attrs) e[a.attr] = a.val;
            return e;
        }

        [Fact]
        public void No_groups_passes_all()
        {
            Assert.True(Eval().EvaluateCriteriaGroups(new List<SearchCriteriaGroup>(), Rec()));
        }

        [Fact]
        public void Root_groups_are_combined_with_And()
        {
            var groups = new List<SearchCriteriaGroup>
            {
                G(LogicalOperator.And, C("status", "eq", "open")),
                G(LogicalOperator.And, C("qty", "eq", "5"))
            };
            var rec = Rec(("status", "open"), ("qty", 5));
            Assert.True(Eval().EvaluateCriteriaGroups(groups, rec));

            var groupsFail = new List<SearchCriteriaGroup>
            {
                G(LogicalOperator.And, C("status", "eq", "open")),
                G(LogicalOperator.And, C("qty", "eq", "99"))
            };
            Assert.False(Eval().EvaluateCriteriaGroups(groupsFail, rec));
        }

        [Fact]
        public void Or_group_passes_when_one_criterion_matches()
        {
            var g = G(LogicalOperator.Or, C("status", "eq", "closed"), C("qty", "eq", "5"));
            Assert.True(Eval().EvaluateCriteriaGroup(g, Rec(("status", "open"), ("qty", 5))));
        }

        [Fact]
        public void Or_group_fails_when_no_criterion_matches()
        {
            var g = G(LogicalOperator.Or, C("status", "eq", "closed"), C("qty", "eq", "99"));
            Assert.False(Eval().EvaluateCriteriaGroup(g, Rec(("status", "open"), ("qty", 5))));
        }

        [Fact]
        public void Empty_group_is_vacuously_true()
        {
            var g = new SearchCriteriaGroup { Id = Guid.NewGuid(), LogicalOperator = LogicalOperator.And };
            Assert.True(Eval().EvaluateCriteriaGroup(g, Rec()));
        }

        [Fact]
        public void Child_groups_compose_under_the_parent_operator()
        {
            // parent OR { (status eq closed) , AND-child { qty eq 5 } } -> child rescues the group
            var child = G(LogicalOperator.And, C("qty", "eq", "5"));
            var parent = G(LogicalOperator.Or, C("status", "eq", "closed"));
            parent.ChildGroups.Add(child);
            Assert.True(Eval().EvaluateCriteriaGroup(parent, Rec(("status", "open"), ("qty", 5))));
        }

        [Fact]
        public void Nested_child_groups_recurse_two_levels()
        {
            var grandchild = G(LogicalOperator.And, C("qty", "eq", "5"));
            var child = G(LogicalOperator.And);
            child.ChildGroups.Add(grandchild);
            var parent = G(LogicalOperator.And);
            parent.ChildGroups.Add(child);
            Assert.True(Eval().EvaluateCriteriaGroup(parent, Rec(("qty", 5))));
            Assert.False(Eval().EvaluateCriteriaGroup(parent, Rec(("qty", 6))));
        }

        [Theory]
        [InlineData("eq", "open", true)]
        [InlineData("ne", "open", false)]
        [InlineData("ne", "closed", true)]
        [InlineData("like", "pe", true)]
        [InlineData("not-like", "pe", false)]
        [InlineData("contains", "op", true)]
        [InlineData("not-contains", "zz", true)]
        public void Scalar_operator_matrix(string op, string value, bool expected)
        {
            var g = G(LogicalOperator.And, C("status", op, value));
            Assert.Equal(expected, Eval().EvaluateCriteriaGroup(g, Rec(("status", "open"))));
        }

        [Fact]
        public void Null_and_not_null_operators()
        {
            var rec = Rec(("status", "open"));
            Assert.False(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("status", "null", null)), rec));
            Assert.True(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("status", "not-null", null)), rec));
            // absent attribute resolves to null
            Assert.True(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("missing", "null", null)), rec));
        }

        [Fact]
        public void Unsupported_operator_throws_naming_the_operator()
        {
            var g = G(LogicalOperator.And, C("status", "startswith", "o"));
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => Eval().EvaluateCriteriaGroup(g, Rec(("status", "open"))));
            Assert.Contains("startswith", ex.Message);
        }

        [Fact]
        public void Multi_select_eq_requires_exact_set_equality()
        {
            var rec = Rec(("tags", new OptionSetValueCollection
                { new OptionSetValue(1), new OptionSetValue(2) }));
            Assert.True(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "eq", "1,2")), rec));
            Assert.False(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "eq", "1")), rec));
        }

        [Fact]
        public void Multi_select_contains_and_not_contains()
        {
            var rec = Rec(("tags", new OptionSetValueCollection
                { new OptionSetValue(1), new OptionSetValue(2) }));
            Assert.True(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "contains", "2")), rec));
            Assert.True(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "not-contains", "9")), rec));
            Assert.False(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "not-contains", "1")), rec));
        }

        [Fact]
        public void Multi_select_null_on_empty_collection_is_true()
        {
            var rec = Rec(("tags", new OptionSetValueCollection()));
            Assert.True(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "null", null)), rec));
            Assert.False(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "not-null", null)), rec));
        }

        [Fact]
        public void Multi_select_value_list_ignores_non_numeric_tokens()
        {
            // ParseIntList drops "abc": "1,abc,2" behaves exactly as "1,2".
            var rec = Rec(("tags", new OptionSetValueCollection
                { new OptionSetValue(1), new OptionSetValue(2) }));
            Assert.True(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "eq", "1,abc,2")), rec));
        }

        [Fact]
        public void Multi_select_null_value_parses_to_empty_list()
        {
            // Documents the sharp edge: a null Value means "eq" matches only an empty
            // collection, and "not-contains" matches everything.
            var rec = Rec(("tags", new OptionSetValueCollection { new OptionSetValue(1) }));
            Assert.False(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "eq", null)), rec));
            Assert.True(Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "not-contains", null)), rec));
        }

        [Fact]
        public void Multi_select_unsupported_operator_throws()
        {
            var rec = Rec(("tags", new OptionSetValueCollection { new OptionSetValue(1) }));
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => Eval().EvaluateCriteriaGroup(G(LogicalOperator.And, C("tags", "gt", "1")), rec));
            Assert.Contains("multi-select", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
