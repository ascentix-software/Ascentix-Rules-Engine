using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class NodeFilterMultiSelectTests
    {
        private static NodeFilterGroup Group(params NodeFilterCriterion[] crit) =>
            new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion>(crit) };

        private static NodeFilterCriterion C(string field, string op, string val) =>
            new NodeFilterCriterion { FieldName = field, Operator = op, Value = val };

        private static Entity Rec(string field, object val)
        {
            var e = new Entity("x"); e[field] = val; return e;
        }

        private static NodeFilterEvaluator Eval() => new NodeFilterEvaluator(new FieldValueResolver());

        [Fact]
        public void Eq_requires_exact_set_equality()
        {
            var rec = Rec("tags", new OptionSetValueCollection
                { new OptionSetValue(1), new OptionSetValue(2) });
            Assert.True(Eval().EvaluateFilterGroup(Group(C("tags", "eq", "1,2")), new List<Entity> { rec }));
            Assert.False(Eval().EvaluateFilterGroup(Group(C("tags", "eq", "1")), new List<Entity> { rec }));
        }

        [Fact]
        public void Ne_is_the_negation_of_set_equality()
        {
            var rec = Rec("tags", new OptionSetValueCollection
                { new OptionSetValue(1), new OptionSetValue(2) });
            Assert.False(Eval().EvaluateFilterGroup(Group(C("tags", "ne", "1,2")), new List<Entity> { rec }));
            Assert.True(Eval().EvaluateFilterGroup(Group(C("tags", "ne", "1")), new List<Entity> { rec }));
        }

        [Fact]
        public void Contains_and_not_contains()
        {
            var rec = Rec("tags", new OptionSetValueCollection
                { new OptionSetValue(1), new OptionSetValue(2) });
            Assert.True(Eval().EvaluateFilterGroup(Group(C("tags", "contains", "2")), new List<Entity> { rec }));
            Assert.True(Eval().EvaluateFilterGroup(Group(C("tags", "not-contains", "9")), new List<Entity> { rec }));
            Assert.False(Eval().EvaluateFilterGroup(Group(C("tags", "not-contains", "1")), new List<Entity> { rec }));
        }

        [Fact]
        public void Null_and_not_null_on_an_empty_collection()
        {
            var rec = Rec("tags", new OptionSetValueCollection());
            Assert.True(Eval().EvaluateFilterGroup(Group(C("tags", "null", null)), new List<Entity> { rec }));
            Assert.False(Eval().EvaluateFilterGroup(Group(C("tags", "not-null", null)), new List<Entity> { rec }));
        }

        [Fact]
        public void Eq_and_contains_are_false_against_a_present_but_empty_collection()
        {
            // Distinct from the null/not-null case above: an empty (non-null) collection can
            // never satisfy "eq" against a non-empty configured set, nor "contains" any value.
            var rec = Rec("tags", new OptionSetValueCollection());
            Assert.False(Eval().EvaluateFilterGroup(Group(C("tags", "eq", "1")), new List<Entity> { rec }));
            Assert.False(Eval().EvaluateFilterGroup(Group(C("tags", "contains", "1")), new List<Entity> { rec }));
        }

        [Fact]
        public void Value_list_ignores_non_numeric_tokens()
        {
            // Deliberate sharp edge: ParseIntList drops "abc" -- "1,abc,2" behaves exactly as "1,2".
            var rec = Rec("tags", new OptionSetValueCollection
                { new OptionSetValue(1), new OptionSetValue(2) });
            Assert.True(Eval().EvaluateFilterGroup(Group(C("tags", "eq", "1,abc,2")), new List<Entity> { rec }));
        }

        [Fact]
        public void Null_value_parses_to_empty_list()
        {
            // Deliberate sharp edge: a null criterion.Value parses to an empty configured list,
            // so "eq" matches only an empty actual collection and "not-contains" matches everything.
            // Validation is advisory (the runner never re-checks), so this is a live runtime state.
            var rec = Rec("tags", new OptionSetValueCollection { new OptionSetValue(1) });
            Assert.False(Eval().EvaluateFilterGroup(Group(C("tags", "eq", null)), new List<Entity> { rec }));
            Assert.True(Eval().EvaluateFilterGroup(Group(C("tags", "not-contains", null)), new List<Entity> { rec }));
        }

        [Fact]
        public void Unsupported_operator_throws_naming_the_operator()
        {
            var rec = Rec("tags", new OptionSetValueCollection { new OptionSetValue(1) });
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => Eval().EvaluateFilterGroup(Group(C("tags", "gt", "1")), new List<Entity> { rec }));
            Assert.Contains("multi-select", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
