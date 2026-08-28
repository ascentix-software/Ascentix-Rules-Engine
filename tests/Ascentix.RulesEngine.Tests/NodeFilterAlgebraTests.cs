using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class NodeFilterAlgebraTests
    {
        private static NodeFilterGroup Group(LogicalOperator op, params NodeFilterCriterion[] crit) =>
            new NodeFilterGroup { LogicalOperator = op, Criteria = new List<NodeFilterCriterion>(crit) };

        private static NodeFilterGroup Group(params NodeFilterCriterion[] crit) =>
            Group(LogicalOperator.And, crit);

        private static NodeFilterCriterion C(string field, string op, string val) =>
            new NodeFilterCriterion { FieldName = field, Operator = op, Value = val };

        private static Entity Rec(string field, object val)
        {
            var e = new Entity("x"); e[field] = val; return e;
        }

        [Fact]
        public void Or_group_passes_when_one_criterion_matches()
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group(LogicalOperator.Or, C("status", "eq", "open"), C("status", "eq", "closed"));
            var records = new List<Entity> { Rec("status", "open") };
            Assert.True(eval.EvaluateFilterGroup(g, records));
        }

        [Fact]
        public void Or_group_fails_when_none_match()
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group(LogicalOperator.Or, C("status", "eq", "pending"), C("status", "eq", "closed"));
            var records = new List<Entity> { Rec("status", "open") };
            Assert.False(eval.EvaluateFilterGroup(g, records));
        }

        [Fact]
        public void Child_groups_compose_under_the_parent_operator()
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver());

            // AND parent with a failing OR child -> false
            var failingOrChild = Group(LogicalOperator.Or, C("status", "eq", "pending"), C("status", "eq", "closed"));
            var andParent = Group(LogicalOperator.And, C("status", "eq", "open"));
            andParent.ChildGroups.Add(failingOrChild);
            var records = new List<Entity> { Rec("status", "open") };
            Assert.False(eval.EvaluateFilterGroup(andParent, records));

            // OR parent with a passing AND child -> true
            var passingAndChild = Group(LogicalOperator.And, C("status", "eq", "open"));
            var orParent = Group(LogicalOperator.Or, C("status", "eq", "closed"));
            orParent.ChildGroups.Add(passingAndChild);
            Assert.True(eval.EvaluateFilterGroup(orParent, records));
        }

        [Fact]
        public void Nested_child_groups_recurse_two_levels()
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver());

            // Leaf (level 2): AND group that passes.
            var leaf = Group(LogicalOperator.And, C("status", "eq", "open"));

            // Level 1 child: OR group whose only criterion fails, but whose child (leaf) passes.
            var level1 = Group(LogicalOperator.Or, C("status", "eq", "closed"));
            level1.ChildGroups.Add(leaf);

            // Root: AND group whose only criterion passes and whose child (level1) also passes.
            var root = Group(LogicalOperator.And, C("status", "eq", "open"));
            root.ChildGroups.Add(level1);

            var records = new List<Entity> { Rec("status", "open") };
            Assert.True(eval.EvaluateFilterGroup(root, records));
        }

        [Fact]
        public void Empty_group_is_vacuously_true()
        {
            // Vacuous-true is load-bearing and dangerous: ConditionGroupMapper produces
            // Criteria=[] when no criterion records are wired, so an EXISTS with an empty
            // sub-filter silently counts EVERY row. Pinned deliberately (see spec).
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group();
            var records = new List<Entity> { Rec("status", "open") };
            Assert.True(eval.EvaluateFilterGroup(g, records));
        }

        [Fact]
        public void Criterion_requires_all_records_to_match()
        {
            // EvaluateFilterGroup folds each criterion to ONE boolean via records.All(...),
            // not one boolean per record. Two rows, one matching -> the criterion is false.
            var eval = new NodeFilterEvaluator(new FieldValueResolver());
            var g = Group(C("status", "eq", "open"));
            var records = new List<Entity> { Rec("status", "open"), Rec("status", "closed") };
            Assert.False(eval.EvaluateFilterGroup(g, records));
        }
    }
}
