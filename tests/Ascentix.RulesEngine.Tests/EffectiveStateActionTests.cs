using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin.Registration;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class EffectiveStateActionTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);
        private static readonly string ActionEntity = Q(SchemaNames.RuleAction.Entity);
        private static readonly string RuleEntity = Q(SchemaNames.Rule.Entity);
        private static readonly string ActionTypeField = Q(SchemaNames.RuleAction.ActionType);
        private static readonly string IsActiveField = Q(SchemaNames.RuleAction.IsActive);
        private static readonly string ActionRuleField = Q(SchemaNames.RuleAction.Rule);

        private static InFlightChange ActionChange(string message, Guid actionId, Guid ruleId, Entity target)
        {
            var ctx = new XrmFakedPluginExecutionContext
            {
                MessageName = message,
                PrimaryEntityName = ActionEntity,
                InputParameters = new ParameterCollection { { "Target",
                    message == "Delete" ? (object)new EntityReference(ActionEntity, actionId) : target } },
                PreEntityImages = new EntityImageCollection { { "PreImage",
                    new Entity(ActionEntity, actionId) { [ActionRuleField] = new EntityReference(RuleEntity, ruleId) } } }
            };
            return InFlightChange.From(ctx);
        }

        private static bool HasServer(Dictionary<Guid, List<RuleAction>> map, Guid ruleId) =>
            map.TryGetValue(ruleId, out var list)
            && list.Any(a => a.IsActive && Core.Actions.ActionDispatcher.IsServerAction(a.ActionType));

        [Fact]
        public void Creating_a_block_action_makes_the_parent_a_server_rule()
        {
            var ruleId = Guid.NewGuid();
            var actionId = Guid.NewGuid();
            var committed = new Dictionary<Guid, List<RuleAction>>();
            var target = new Entity(ActionEntity, actionId)
            {
                [ActionRuleField] = new EntityReference(RuleEntity, ruleId),
                [ActionTypeField] = new OptionSetValue((int)ActionType.Block),
                [IsActiveField] = true
            };
            var change = ActionChange("Create", actionId, ruleId, target);

            var result = EffectiveState.ApplyActionDelta(committed, change);

            Assert.True(HasServer(result, ruleId));
        }

        [Fact]
        public void Creating_a_block_action_without_explicit_isactive_defaults_to_active()
        {
            var ruleId = Guid.NewGuid();
            var actionId = Guid.NewGuid();
            var target = new Entity(ActionEntity, actionId)
            {
                [ActionRuleField] = new EntityReference(RuleEntity, ruleId),
                [ActionTypeField] = new OptionSetValue((int)ActionType.Block)
                // no isactive on the sparse Target
            };
            var change = ActionChange("Create", actionId, ruleId, target);

            var result = EffectiveState.ApplyActionDelta(new Dictionary<Guid, List<RuleAction>>(), change);

            Assert.True(HasServer(result, ruleId));
        }

        [Fact]
        public void Deleting_the_last_block_action_makes_the_parent_non_server()
        {
            var ruleId = Guid.NewGuid();
            var actionId = Guid.NewGuid();
            var committed = new Dictionary<Guid, List<RuleAction>>
            {
                [ruleId] = new List<RuleAction>
                {
                    new RuleAction { Id = actionId, RuleId = ruleId, ActionType = ActionType.Block, IsActive = true }
                }
            };
            var change = ActionChange("Delete", actionId, ruleId, null);

            var result = EffectiveState.ApplyActionDelta(committed, change);

            Assert.False(HasServer(result, ruleId));
            // input not mutated
            Assert.True(HasServer(committed, ruleId));
        }

        [Fact]
        public void Updating_an_action_from_showmessage_to_block_makes_the_parent_server()
        {
            var ruleId = Guid.NewGuid();
            var actionId = Guid.NewGuid();
            var committed = new Dictionary<Guid, List<RuleAction>>
            {
                [ruleId] = new List<RuleAction>
                {
                    new RuleAction { Id = actionId, RuleId = ruleId, ActionType = ActionType.ShowMessage, IsActive = true }
                }
            };
            var target = new Entity(ActionEntity, actionId)
            {
                [ActionTypeField] = new OptionSetValue((int)ActionType.Block)
            };
            var change = ActionChange("Update", actionId, ruleId, target);

            var result = EffectiveState.ApplyActionDelta(committed, change);

            Assert.True(HasServer(result, ruleId));
            Assert.False(HasServer(committed, ruleId)); // input not mutated
        }

        [Fact]
        public void Null_change_returns_a_copy_unchanged()
        {
            var ruleId = Guid.NewGuid();
            var committed = new Dictionary<Guid, List<RuleAction>>
            {
                [ruleId] = new List<RuleAction> { new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.Block, IsActive = true } }
            };

            var result = EffectiveState.ApplyActionDelta(committed, null);

            Assert.True(HasServer(result, ruleId));
            Assert.NotSame(committed, result);
        }
    }
}
