using System;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin.Registration;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RegistrationInFlightChangeTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);
        private static readonly string RuleEntity = Q(SchemaNames.Rule.Entity);
        private static readonly string ActionEntity = Q(SchemaNames.RuleAction.Entity);

        [Fact]
        public void Publish_update_is_recognized_as_a_rule_publish()
        {
            var ruleId = Guid.NewGuid();
            var target = new Entity(RuleEntity, ruleId)
            {
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published)
            };
            var preImage = new Entity(RuleEntity, ruleId)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account"
            };
            var ctx = new XrmFakedPluginExecutionContext
            {
                MessageName = "Update",
                PrimaryEntityName = RuleEntity,
                InputParameters = new ParameterCollection { { "Target", target } },
                PreEntityImages = new EntityImageCollection { { "PreImage", preImage } }
            };

            var change = InFlightChange.From(ctx);

            Assert.Equal(ChangeEntity.Rule, change.Entity);
            Assert.Equal(ChangeMessage.Update, change.Message);
            Assert.Equal(ruleId, change.RecordId);
            Assert.Equal("account", change.EffectiveTable);
            Assert.True(change.IsRulePublish);
            Assert.False(change.IsRuleUnpublish);
            Assert.False(change.IsRuleDelete);
        }

        [Fact]
        public void Unpublish_update_is_recognized()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedPluginExecutionContext
            {
                MessageName = "Update",
                PrimaryEntityName = RuleEntity,
                InputParameters = new ParameterCollection
                {
                    { "Target", new Entity(RuleEntity, ruleId) { ["statuscode"] = new OptionSetValue((int)RuleStatus.Draft) } }
                }
            };

            var change = InFlightChange.From(ctx);

            Assert.True(change.IsRuleUnpublish);
            Assert.False(change.IsRulePublish);
        }

        [Fact]
        public void Draft_create_without_statuscode_is_neither_publish_nor_unpublish()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedPluginExecutionContext
            {
                MessageName = "Create",
                PrimaryEntityName = RuleEntity,
                InputParameters = new ParameterCollection
                {
                    { "Target", new Entity(RuleEntity, ruleId) { [Q(SchemaNames.Rule.TableLogicalName)] = "account" } }
                }
            };

            var change = InFlightChange.From(ctx);

            Assert.False(change.IsRulePublish);
            Assert.False(change.IsRuleUnpublish);
        }

        [Fact]
        public void Rule_delete_resolves_record_id_from_entity_reference_target()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedPluginExecutionContext
            {
                MessageName = "Delete",
                PrimaryEntityName = RuleEntity,
                InputParameters = new ParameterCollection { { "Target", new EntityReference(RuleEntity, ruleId) } },
                PreEntityImages = new EntityImageCollection
                {
                    { "PreImage", new Entity(RuleEntity, ruleId) { [Q(SchemaNames.Rule.TableLogicalName)] = "account" } }
                }
            };

            var change = InFlightChange.From(ctx);

            Assert.True(change.IsRuleDelete);
            Assert.Equal(ruleId, change.RecordId);
            Assert.Equal("account", change.EffectiveTable);
        }

        [Fact]
        public void Action_change_resolves_parent_rule_id()
        {
            var actionId = Guid.NewGuid();
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedPluginExecutionContext
            {
                MessageName = "Create",
                PrimaryEntityName = ActionEntity,
                InputParameters = new ParameterCollection
                {
                    { "Target", new Entity(ActionEntity, actionId)
                        { [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(RuleEntity, ruleId) } }
                }
            };

            var change = InFlightChange.From(ctx);

            Assert.Equal(ChangeEntity.Action, change.Entity);
            Assert.Equal(actionId, change.RecordId);
            Assert.Equal(ruleId, change.ParentRuleId);
        }
    }
}
