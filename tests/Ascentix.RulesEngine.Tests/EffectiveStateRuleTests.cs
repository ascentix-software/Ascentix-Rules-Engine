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
    public class EffectiveStateRuleTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);
        private static readonly string RuleEntity = Q(SchemaNames.Rule.Entity);
        private static readonly string TableField = Q(SchemaNames.Rule.TableLogicalName);
        private static readonly string TriggersField = Q(SchemaNames.Rule.Triggers);

        private static Entity Rule(Guid id, string table) =>
            new Entity(RuleEntity, id) { [TableField] = table };

        private static InFlightChange RuleChange(string message, Guid id, string table, int? status)
        {
            var target = new Entity(RuleEntity, id) { [TableField] = table };
            if (status.HasValue) target["statuscode"] = new OptionSetValue(status.Value);
            var ctx = new XrmFakedPluginExecutionContext
            {
                MessageName = message,
                PrimaryEntityName = RuleEntity,
                InputParameters = new ParameterCollection { { "Target",
                    message == "Delete" ? (object)new EntityReference(RuleEntity, id) : target } },
                PreEntityImages = new EntityImageCollection { { "PreImage", Rule(id, table) } }
            };
            return InFlightChange.From(ctx);
        }

        [Fact]
        public void Publish_adds_the_extra_rule_when_absent_from_committed()
        {
            var committed = new List<Entity>();
            var ruleId = Guid.NewGuid();
            var change = RuleChange("Update", ruleId, "account", (int)RuleStatus.Published);
            var extra = Rule(ruleId, "account");

            var result = EffectiveState.ApplyRuleDelta(committed, change, extra, "account");

            Assert.Single(result);
            Assert.Equal(ruleId, result[0].Id);
        }

        [Fact]
        public void Publish_does_not_add_to_a_different_table()
        {
            var ruleId = Guid.NewGuid();
            var change = RuleChange("Update", ruleId, "account", (int)RuleStatus.Published);
            var extra = Rule(ruleId, "account");

            var result = EffectiveState.ApplyRuleDelta(new List<Entity>(), change, extra, "contact");

            Assert.Empty(result);
        }

        [Fact]
        public void Unpublish_removes_the_rule_from_committed()
        {
            var ruleId = Guid.NewGuid();
            var committed = new List<Entity> { Rule(ruleId, "account") };
            var change = RuleChange("Update", ruleId, "account", (int)RuleStatus.Draft);

            var result = EffectiveState.ApplyRuleDelta(committed, change, null, "account");

            Assert.Empty(result);
        }

        [Fact]
        public void Delete_removes_the_rule_from_committed()
        {
            var ruleId = Guid.NewGuid();
            var committed = new List<Entity> { Rule(ruleId, "account") };
            var change = RuleChange("Delete", ruleId, "account", null);

            var result = EffectiveState.ApplyRuleDelta(committed, change, null, "account");

            Assert.Empty(result);
        }

        [Fact]
        public void Triggers_change_overlays_onto_the_present_rule()
        {
            var ruleId = Guid.NewGuid();
            var committed = new List<Entity> { Rule(ruleId, "account") };
            var change = RuleChange("Update", ruleId, "account", null);
            change.Target[TriggersField] = new OptionSetValueCollection(
                new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) });

            var result = EffectiveState.ApplyRuleDelta(committed, change, null, "account");

            var triggers = result.Single().GetAttributeValue<OptionSetValueCollection>(TriggersField);
            Assert.Contains(triggers, o => o.Value == (int)RuleTrigger.OnUpdate);
        }

        [Fact]
        public void Overlaying_triggers_does_not_mutate_the_committed_input_entity()
        {
            var ruleId = Guid.NewGuid();
            var committedRule = Rule(ruleId, "account");
            var committed = new List<Entity> { committedRule };
            var change = RuleChange("Update", ruleId, "account", null);
            change.Target[TriggersField] = new OptionSetValueCollection(
                new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) });

            EffectiveState.ApplyRuleDelta(committed, change, null, "account");

            Assert.False(committedRule.Contains(TriggersField)); // input entity untouched
        }

        [Fact]
        public void Null_change_returns_a_copy_unchanged()
        {
            var committed = new List<Entity> { Rule(Guid.NewGuid(), "account") };

            var result = EffectiveState.ApplyRuleDelta(committed, null, null, "account");

            Assert.Single(result);
            Assert.NotSame(committed, result);
        }
    }
}
