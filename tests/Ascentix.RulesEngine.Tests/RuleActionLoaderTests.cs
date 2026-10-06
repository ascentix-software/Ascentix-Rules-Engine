using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleActionLoaderTests
    {
        private static readonly Guid Outcome = Guid.NewGuid();

        /// <summary>The action row followed by its "Fires when" tree rows.</summary>
        private static List<Entity> Action(Guid ruleId, int type, Func<Guid, List<Entity>> when, string message, int order, bool active)
        {
            var e = new Entity(SchemaNames.Qualify(SchemaNames.RuleAction.Entity), Guid.NewGuid());
            e[SchemaNames.Qualify(SchemaNames.RuleAction.Rule)] =
                new EntityReference(SchemaNames.Qualify(SchemaNames.Rule.Entity), ruleId);
            e[SchemaNames.Qualify(SchemaNames.RuleAction.ActionType)] = new OptionSetValue(type);
            e[SchemaNames.Qualify(SchemaNames.RuleAction.Message)] = message;
            e[SchemaNames.Qualify(SchemaNames.RuleAction.Order)] = order;
            e[SchemaNames.Qualify(SchemaNames.RuleAction.IsActive)] = active;
            var rows = new List<Entity> { e };
            rows.AddRange(when(e.Id));
            return rows;
        }

        private static List<Entity> AllTrue(Guid actionId) => ActionTreeRows.AllTrue(actionId, Outcome);
        private static List<Entity> AnyFalse(Guid actionId) => ActionTreeRows.AnyFalse(actionId, Outcome);

        [Fact]
        public void LoadActionsByRule_groups_actions_under_their_rule()
        {
            var ruleId = Guid.NewGuid();
            var context = new XrmFakedContext();
            context.Initialize(new List<Entity>
            {
                Action(ruleId, (int)ActionType.Block, AnyFalse, "Invalid.", 1, true),
            });
            var service = context.GetOrganizationService();

            var loaded = new RuleActionLoader(service).LoadActionsByRule(new[] { ruleId });

            Assert.True(loaded.ContainsKey(ruleId));
            var action = Assert.Single(loaded[ruleId]);
            Assert.Equal(ActionType.Block, action.ActionType);
            Assert.Equal(LogicalOperator.Or, action.Condition.LogicalOperator);
            var test = Assert.Single(action.Condition.Tests);
            Assert.Equal(Outcome, test.OutcomeId);
            Assert.False(test.Expected);
            Assert.Equal("Invalid.", action.Message);
            Assert.True(action.IsActive);
            Assert.Equal(ruleId, action.RuleId);
        }

        [Fact]
        public void LoadActionsByRule_with_no_ids_returns_empty()
        {
            var context = new XrmFakedContext();
            var service = context.GetOrganizationService();
            Assert.Empty(new RuleActionLoader(service).LoadActionsByRule(new Guid[0]));
        }

        [Fact]
        public void LoadActionsByRule_buckets_actions_under_their_respective_rules()
        {
            var ruleA = Guid.NewGuid();
            var ruleB = Guid.NewGuid();
            var context = new XrmFakedContext();
            context.Initialize(new List<Entity>
            {
                Action(ruleA, (int)ActionType.Block, AnyFalse, "a1", 1, true),
                Action(ruleA, (int)ActionType.ShowMessage, AllTrue, "a2", 2, true),
                Action(ruleB, (int)ActionType.Block, AnyFalse, "b1", 1, true),
            });
            var service = context.GetOrganizationService();

            var loaded = new RuleActionLoader(service).LoadActionsByRule(new[] { ruleA, ruleB });

            Assert.Equal(2, loaded[ruleA].Count);
            Assert.Single(loaded[ruleB]);
            Assert.All(loaded[ruleA], a => Assert.Equal(ruleA, a.RuleId));
        }

        [Fact]
        public void LoadActionsByRule_returns_inactive_actions_too()
        {
            var ruleId = Guid.NewGuid();
            var context = new XrmFakedContext();
            context.Initialize(new List<Entity>
            {
                Action(ruleId, (int)ActionType.Block, AnyFalse, "inactive", 1, false),
            });
            var service = context.GetOrganizationService();

            var loaded = new RuleActionLoader(service).LoadActionsByRule(new[] { ruleId });

            var action = Assert.Single(loaded[ruleId]);
            Assert.False(action.IsActive); // loader does not filter on IsActive; the dispatcher decides
        }
    }
}
