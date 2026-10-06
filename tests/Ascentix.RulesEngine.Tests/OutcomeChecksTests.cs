using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Validation;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class OutcomeChecksTests
    {
        private static ConditionGroup Outcome(string name) => new ConditionGroup { Id = Guid.NewGuid(), Name = name };

        private static RuleForValidation Model(IEnumerable<ConditionGroup> groups, params RuleAction[] actions) => new RuleForValidation
        {
            RuleId = Guid.NewGuid(),
            PrimaryTable = "account",
            Groups = groups.ToList(),
            Actions = actions.ToList(),
        };

        private static RuleAction Action(ActionConditionGroup tree, bool active = true) =>
            new RuleAction { Id = Guid.NewGuid(), IsActive = active, Condition = tree };

        private static List<ValidationIssue> Run(RuleForValidation m) => new OutcomeChecks().Check(m).ToList();

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("   ")]
        public void Unnamed_outcome_is_an_error_on_the_group(string name)
        {
            var o = Outcome(name);
            var issues = Run(Model(new[] { o }, Action(ActionTrees.AllTrue(o.Id))));
            var issue = Assert.Single(issues, i => i.Code == "OUTCOME_UNNAMED");
            Assert.Equal(o.Id, issue.Target.Id);
            Assert.Equal(TargetKind.Group, issue.Target.Kind);
        }

        [Fact]
        public void Unnamed_execution_group_and_nested_group_are_fine()
        {
            var named = Outcome("Ok");
            named.ChildGroups.Add(new ConditionGroup { Id = Guid.NewGuid(), ParentConditionGroupId = named.Id });
            var exec = new ConditionGroup { Id = Guid.NewGuid(), IsExecutionCondition = true };
            var issues = Run(Model(new[] { named, exec }, Action(ActionTrees.AllTrue(named.Id))));
            Assert.DoesNotContain(issues, i => i.Code == "OUTCOME_UNNAMED");
        }

        [Fact]
        public void Duplicate_names_ignore_case_and_whitespace_and_flag_the_second()
        {
            var a = Outcome("High value");
            var b = Outcome(" high VALUE ");
            var issues = Run(Model(new[] { a, b }, Action(ActionTrees.AllTrue(a.Id, b.Id))));
            var issue = Assert.Single(issues, i => i.Code == "OUTCOME_DUPLICATE_NAME");
            Assert.Equal(b.Id, issue.Target.Id);
        }

        [Fact]
        public void Active_action_without_a_tree_is_an_error()
        {
            var o = Outcome("A");
            var act = Action(null);
            var issues = Run(Model(new[] { o }, act));
            var issue = Assert.Single(issues, i => i.Code == "ACTION_NO_TREE");
            Assert.Equal("Choose when this action fires.", issue.Message);
            Assert.Equal(TargetKind.Action, issue.Target.Kind);
            Assert.Equal(act.Id, issue.Target.Id);
        }

        [Fact]
        public void Inactive_action_without_a_tree_is_ignored()
        {
            var o = Outcome("A");
            var issues = Run(Model(new[] { o }, Action(null, active: false)));
            Assert.DoesNotContain(issues, i => i.Code == "ACTION_NO_TREE");
        }

        [Fact]
        public void Test_with_null_outcome_is_unknown()
        {
            var o = Outcome("A");
            var tree = ActionTrees.AllTrue(o.Id);
            tree.Tests.Add(new ActionConditionTest { Id = Guid.NewGuid(), OutcomeId = null });
            var issues = Run(Model(new[] { o }, Action(tree)));
            Assert.Single(issues, i => i.Code == "ACTION_TEST_UNKNOWN_OUTCOME");
        }

        [Fact]
        public void Test_with_outcome_not_in_the_rule_is_unknown()
        {
            var o = Outcome("A");
            var issues = Run(Model(new[] { o }, Action(ActionTrees.AllTrue(Guid.NewGuid()))));
            Assert.Single(issues, i => i.Code == "ACTION_TEST_UNKNOWN_OUTCOME");
        }

        [Fact]
        public void Test_pointing_at_an_execution_group_is_unknown()
        {
            var o = Outcome("A");
            var exec = new ConditionGroup { Id = Guid.NewGuid(), Name = "Exec", IsExecutionCondition = true };
            var issues = Run(Model(new[] { o, exec }, Action(ActionTrees.AllTrue(exec.Id))));
            Assert.Single(issues, i => i.Code == "ACTION_TEST_UNKNOWN_OUTCOME");
        }

        [Fact]
        public void Test_pointing_at_a_nested_group_is_unknown()
        {
            var o = Outcome("A");
            var nested = new ConditionGroup { Id = Guid.NewGuid(), Name = "Nested", ParentConditionGroupId = o.Id };
            o.ChildGroups.Add(nested);
            var issues = Run(Model(new[] { o }, Action(ActionTrees.AllTrue(nested.Id))));
            Assert.Single(issues, i => i.Code == "ACTION_TEST_UNKNOWN_OUTCOME");
        }

        [Fact]
        public void Empty_nested_group_is_an_error()
        {
            var o = Outcome("A");
            var tree = ActionTrees.AllTrue(o.Id);
            tree.Groups.Add(new ActionConditionGroup { Id = Guid.NewGuid(), LogicalOperator = LogicalOperator.And });
            var issues = Run(Model(new[] { o }, Action(tree)));
            Assert.Single(issues, i => i.Code == "ACTION_EMPTY_GROUP");
        }

        [Fact]
        public void Empty_root_any_is_an_error()
        {
            var o = Outcome("A");
            var issues = Run(Model(new[] { o }, Action(new ActionConditionGroup { Id = Guid.NewGuid(), LogicalOperator = LogicalOperator.Or })));
            Assert.Single(issues, i => i.Code == "ACTION_EMPTY_GROUP");
        }

        [Fact]
        public void Empty_root_all_is_always_and_fine()
        {
            var o = Outcome("A");
            var issues = Run(Model(new[] { o }, Action(ActionTrees.Always())));
            Assert.DoesNotContain(issues, i => i.Code == "ACTION_EMPTY_GROUP");
        }

        [Fact]
        public void Outcome_no_active_action_uses_is_a_warning()
        {
            var used = Outcome("Used");
            var unused = Outcome("Unused");
            var issues = Run(Model(new[] { used, unused }, Action(ActionTrees.AllTrue(used.Id))));
            var issue = Assert.Single(issues, i => i.Code == "OUTCOME_UNUSED");
            Assert.Equal(unused.Id, issue.Target.Id);
            Assert.Equal(IssueSeverity.Warning, issue.Severity);
        }

        [Fact]
        public void Outcome_used_only_by_an_inactive_action_is_unused()
        {
            var o = Outcome("A");
            var issues = Run(Model(new[] { o }, Action(ActionTrees.AllTrue(o.Id), active: false)));
            Assert.Single(issues, i => i.Code == "OUTCOME_UNUSED");
        }

        [Fact]
        public void Rule_with_no_outcomes_has_no_warnings()
        {
            var issues = Run(Model(new ConditionGroup[0], Action(ActionTrees.Always())));
            Assert.DoesNotContain(issues, i => i.Code == "OUTCOME_UNUSED");
        }
    }
}
