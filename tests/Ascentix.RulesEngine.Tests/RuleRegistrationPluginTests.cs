using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleRegistrationPluginTests
    {
        private const string PluginTypeName = "Ascentix.RulesEngine.Plugin.RulesEnginePlugin";
        private static string Q(string f) => SchemaNames.Qualify(f);

        // Seed plugintype + the Update sdkmessage + an account Update filter.
        private static List<Entity> SeedRegistrationMetadata(Guid pluginTypeId)
        {
            var updateMsgId = Guid.NewGuid();
            return new List<Entity>
            {
                new Entity("plugintype", pluginTypeId) { ["typename"] = PluginTypeName },
                new Entity("sdkmessage", updateMsgId) { ["name"] = "Update" },
                new Entity("sdkmessagefilter", Guid.NewGuid())
                {
                    ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsgId),
                    ["primaryobjecttypecode"] = "account",
                },
            };
        }

        private static List<Entity> SeedAccountRule(Guid ruleId, out Entity ruleTarget, ActionType actionType = ActionType.Block)
        {
            var cfgId = Guid.NewGuid(); var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid(); var actId = Guid.NewGuid();

            ruleTarget = new Entity(Q(SchemaNames.Rule.Entity), ruleId)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
            };

            return new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), cfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                ruleTarget,
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), condId)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), cfgId),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                    [Q(SchemaNames.RuleCondition.ComparisonValue)] = "Valid",
                },
                new Entity(Q(SchemaNames.RuleAction.Entity), actId)
                {
                    [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)actionType),
                    [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnNoMatch),
                    [Q(SchemaNames.RuleAction.Order)] = 1,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                },
            };
        }

        // Seed one existing engine-owned Update step for `account`, owned by the plugin type and
        // linked to the seeded "Update" sdkmessage so GetEngineSteps' inner join resolves it.
        private static Entity SeedExistingUpdateStep(Guid pluginTypeId, List<Entity> seed)
        {
            var updateMsg = seed.First(e => e.LogicalName == "sdkmessage"
                && e.GetAttributeValue<string>("name") == "Update");
            return new Entity("sdkmessageprocessingstep", Guid.NewGuid())
            {
                ["name"] = "Ascentix.RulesEngine: account Update",
                ["eventhandler"] = new EntityReference("plugintype", pluginTypeId),
                ["sdkmessageid"] = new EntityReference("sdkmessage", updateMsg.Id),
            };
        }

        [Fact]
        public void Publishing_an_onupdate_block_rule_registers_one_update_step_on_the_table()
        {
            var ctx = new XrmFakedContext();
            var pluginTypeId = Guid.NewGuid();
            var ruleId = Guid.NewGuid();
            var seed = SeedRegistrationMetadata(pluginTypeId);

            // Seed the rule + graph as committed-DRAFT (its actions were saved while Draft).
            seed.AddRange(SeedAccountRule(ruleId, out var ruleTarget));
            ruleTarget["statuscode"] = new OptionSetValue((int)RuleStatus.Draft);
            ctx.Initialize(seed);

            // Publish: Update flipping statuscode -> Published (Target carries only the delta).
            var publishTarget = new Entity(Q(SchemaNames.Rule.Entity), ruleId)
            {
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published)
            };
            var preImage = new Entity(Q(SchemaNames.Rule.Entity), ruleId)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account"
            };

            ctx.ExecutePluginWith<RuleRegistrationPlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "Update",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.Rule.Entity),
                InputParameters = new ParameterCollection { { "Target", publishTarget } },
                PreEntityImages = new EntityImageCollection { { "PreImage", preImage } }
            });

            var step = Assert.Single(ctx.CreateQuery("sdkmessageprocessingstep").ToList());
            Assert.Equal("Ascentix.RulesEngine: account Update", step.GetAttributeValue<string>("name"));
            Assert.Equal("name", step.GetAttributeValue<string>("filteringattributes")); // root-only rule
            Assert.Equal(pluginTypeId, step.GetAttributeValue<EntityReference>("eventhandler").Id);
        }

        [Fact]
        public void Creating_a_client_only_rule_registers_no_step()
        {
            var ctx = new XrmFakedContext();
            var pluginTypeId = Guid.NewGuid();
            var seed = SeedRegistrationMetadata(pluginTypeId);
            seed.AddRange(SeedAccountRule(Guid.NewGuid(), out var ruleTarget, ActionType.ShowMessage));
            ctx.Initialize(seed);

            ctx.ExecutePluginWith<RuleRegistrationPlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "Create",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.Rule.Entity),
                InputParameters = new ParameterCollection { { "Target", ruleTarget } }
            });

            Assert.Empty(ctx.CreateQuery("sdkmessageprocessingstep").ToList());
        }

        [Fact]
        public void Creating_a_block_action_registers_the_step_for_its_parent_rules_table()
        {
            var ctx = new XrmFakedContext();
            var pluginTypeId = Guid.NewGuid();
            var seed = SeedRegistrationMetadata(pluginTypeId);
            seed.AddRange(SeedAccountRule(Guid.NewGuid(), out _));
            ctx.Initialize(seed);

            // Fire on the action's Create: the plugin must resolve the parent rule's table.
            var action = seed.First(e => e.LogicalName == Q(SchemaNames.RuleAction.Entity));

            ctx.ExecutePluginWith<RuleRegistrationPlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "Create",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.RuleAction.Entity),
                InputParameters = new ParameterCollection { { "Target", action } }
            });

            var step = Assert.Single(ctx.CreateQuery("sdkmessageprocessingstep").ToList());
            Assert.Equal("Ascentix.RulesEngine: account Update", step.GetAttributeValue<string>("name"));
        }

        [Fact]
        public void Unpublishing_a_rule_removes_its_update_step()
        {
            var ctx = new XrmFakedContext();
            var pluginTypeId = Guid.NewGuid();
            var ruleId = Guid.NewGuid();
            var seed = SeedRegistrationMetadata(pluginTypeId);
            seed.AddRange(SeedAccountRule(ruleId, out _));   // committed-Published rule
            seed.Add(SeedExistingUpdateStep(pluginTypeId, seed));  // its step already exists
            ctx.Initialize(seed);

            var target = new Entity(Q(SchemaNames.Rule.Entity), ruleId)
            {
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Draft)
            };
            var preImage = new Entity(Q(SchemaNames.Rule.Entity), ruleId)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account"
            };

            ctx.ExecutePluginWith<RuleRegistrationPlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "Update",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.Rule.Entity),
                InputParameters = new ParameterCollection { { "Target", target } },
                PreEntityImages = new EntityImageCollection { { "PreImage", preImage } }
            });

            Assert.Empty(ctx.CreateQuery("sdkmessageprocessingstep").ToList());
        }

        [Fact]
        public void Deleting_the_last_rule_removes_its_update_step()
        {
            var ctx = new XrmFakedContext();
            var pluginTypeId = Guid.NewGuid();
            var ruleId = Guid.NewGuid();
            var seed = SeedRegistrationMetadata(pluginTypeId);
            seed.AddRange(SeedAccountRule(ruleId, out _));
            seed.Add(SeedExistingUpdateStep(pluginTypeId, seed));
            ctx.Initialize(seed);

            var preImage = new Entity(Q(SchemaNames.Rule.Entity), ruleId)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account"
            };

            ctx.ExecutePluginWith<RuleRegistrationPlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "Delete",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.Rule.Entity),
                InputParameters = new ParameterCollection { { "Target", new EntityReference(Q(SchemaNames.Rule.Entity), ruleId) } },
                PreEntityImages = new EntityImageCollection { { "PreImage", preImage } }
            });

            Assert.Empty(ctx.CreateQuery("sdkmessageprocessingstep").ToList());
        }

        [Fact]
        public void Adding_the_first_block_action_to_a_published_rule_registers_the_step()
        {
            var ctx = new XrmFakedContext();
            var pluginTypeId = Guid.NewGuid();
            var ruleId = Guid.NewGuid();
            var seed = SeedRegistrationMetadata(pluginTypeId);

            // Committed-Published rule whose only action is client-only (no server step yet).
            seed.AddRange(SeedAccountRule(ruleId, out _, ActionType.ShowMessage));
            ctx.Initialize(seed);

            // The in-flight new Block action (not yet committed).
            var newAction = new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };

            ctx.ExecutePluginWith<RuleRegistrationPlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "Create",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.RuleAction.Entity),
                InputParameters = new ParameterCollection { { "Target", newAction } }
            });

            var step = Assert.Single(ctx.CreateQuery("sdkmessageprocessingstep").ToList());
            Assert.Equal("Ascentix.RulesEngine: account Update", step.GetAttributeValue<string>("name"));
        }

        [Fact]
        public void Deleting_the_last_block_action_removes_the_step()
        {
            var ctx = new XrmFakedContext();
            var pluginTypeId = Guid.NewGuid();
            var ruleId = Guid.NewGuid();
            var seed = SeedRegistrationMetadata(pluginTypeId);
            seed.AddRange(SeedAccountRule(ruleId, out _));  // committed Block action
            seed.Add(SeedExistingUpdateStep(pluginTypeId, seed));

            var action = seed.First(e => e.LogicalName == Q(SchemaNames.RuleAction.Entity));
            ctx.Initialize(seed);

            ctx.ExecutePluginWith<RuleRegistrationPlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "Delete",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.RuleAction.Entity),
                InputParameters = new ParameterCollection { { "Target", new EntityReference(Q(SchemaNames.RuleAction.Entity), action.Id) } },
                PreEntityImages = new EntityImageCollection
                {
                    { "PreImage", new Entity(Q(SchemaNames.RuleAction.Entity), action.Id)
                        { [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId) } }
                }
            });

            Assert.Empty(ctx.CreateQuery("sdkmessageprocessingstep").ToList());
        }
    }
}
