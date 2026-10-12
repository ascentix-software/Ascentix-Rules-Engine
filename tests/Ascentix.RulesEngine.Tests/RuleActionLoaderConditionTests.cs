using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleActionLoaderConditionTests
    {
        private static readonly Guid RuleId = Guid.NewGuid();
        private static string Q(string name) => SchemaNames.Qualify(name);

        private static Entity Action(string name, int order)
        {
            var e = new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid());
            e[Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), RuleId);
            e[Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block);
            e[Q(SchemaNames.PrimaryName)] = name;
            e[Q(SchemaNames.RuleAction.Order)] = order;
            e[Q(SchemaNames.RuleAction.IsActive)] = true;
            return e;
        }

        private static Entity Group(Entity action, int op, int order, Entity parent = null)
        {
            var e = new Entity(Q(SchemaNames.ActionConditionGroup.Entity), Guid.NewGuid());
            e[Q(SchemaNames.ActionConditionGroup.RuleAction)] = action.ToEntityReference();
            e[Q(SchemaNames.ActionConditionGroup.LogicalOperator)] = new OptionSetValue(op);
            e[Q(SchemaNames.ActionConditionGroup.Order)] = order;
            if (parent != null) e[Q(SchemaNames.ActionConditionGroup.ParentGroup)] = parent.ToEntityReference();
            return e;
        }

        private static Entity Test(Entity group, Guid outcome, bool expected, int order)
        {
            var e = new Entity(Q(SchemaNames.ActionConditionTest.Entity), Guid.NewGuid());
            e[Q(SchemaNames.ActionConditionTest.Group)] = group.ToEntityReference();
            e[Q(SchemaNames.ActionConditionTest.Outcome)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), outcome);
            e[Q(SchemaNames.ActionConditionTest.Expected)] = expected;
            e[Q(SchemaNames.ActionConditionTest.Order)] = order;
            return e;
        }

        private static Dictionary<string, RuleAction> Load(params Entity[] rows)
        {
            var context = new XrmFakedContext();
            context.Initialize(rows.ToList());
            return new RuleActionLoader(context.GetOrganizationService()).LoadActionsByRule(new[] { RuleId })[RuleId]
                .ToDictionary(a => a.Name);
        }

        [Fact]
        public void Loads_the_tree_nested_groups_and_ordered_tests_and_leaves_treeless_actions_null()
        {
            var g1 = Guid.NewGuid(); var g2 = Guid.NewGuid(); var g3 = Guid.NewGuid();
            var tree = Action("tree", 1); var none = Action("none", 2); var always = Action("always", 3);
            var root = Group(tree, 1, 1); var any = Group(tree, 2, 1, root);
            var loaded = Load(tree, none, always, root, any,
                Test(root, g1, true, 1),
                Test(any, g3, false, 2), Test(any, g2, true, 1),
                Group(always, 1, 1));

            var condition = loaded["tree"].Condition;
            Assert.Equal(LogicalOperator.And, condition.LogicalOperator);
            var rootTest = Assert.Single(condition.Tests);
            Assert.Equal(g1, rootTest.OutcomeId); Assert.True(rootTest.Expected);
            var child = Assert.Single(condition.Groups);
            Assert.Equal(LogicalOperator.Or, child.LogicalOperator);
            Assert.Equal(new Guid?[] { g2, g3 }, child.Tests.Select(t => t.OutcomeId).ToArray());
            Assert.Equal(new[] { true, false }, child.Tests.Select(t => t.Expected).ToArray());

            Assert.Null(loaded["none"].Condition);
            var empty = loaded["always"].Condition;
            Assert.Equal(LogicalOperator.And, empty.LogicalOperator);
            Assert.Empty(empty.Tests); Assert.Empty(empty.Groups);
        }

        [Fact]
        public void An_action_with_two_root_groups_fails_to_load()
        {
            var action = Action("twice", 1);
            var error = Assert.Throws<InvalidPluginExecutionException>(() => Load(action, Group(action, 1, 1), Group(action, 1, 2)));
            Assert.Contains("more than one", error.Message);
        }

        [Fact]
        public void Condition_group_mapper_maps_the_group_name()
        {
            var rule = new Entity(Q(SchemaNames.Rule.Entity), RuleId);
            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), Guid.NewGuid());
            group[Q(SchemaNames.PrimaryName)] = "Under 18";
            group[Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue(1);
            rule.RelatedEntities[new Relationship(Q(SchemaNames.Relationships.RuleConditionGroup))] =
                new EntityCollection(new List<Entity> { group });
            var mapped = new ConditionGroupMapper().MapConditionGroups(new List<Entity> { rule });
            Assert.Equal("Under 18", Assert.Single(mapped).Name);
        }
    }
}
