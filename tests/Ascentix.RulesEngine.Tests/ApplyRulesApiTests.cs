using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ApplyRulesApiTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // account.name is not null → Update Record (root) sets description = "applied" (OnMatch);
        // Block "Needs a name" (OnNoMatch); published, tagged OnDemand.
        private static (List<Entity> Seed, Guid RuleId) Seed(OptionSetValue onDemandScope = null)
        {
            var ids = (rule: Guid.NewGuid(), cfg: Guid.NewGuid(), grp: Guid.NewGuid(),
                       cond: Guid.NewGuid(), updateAct: Guid.NewGuid(), blockAct: Guid.NewGuid());
            var tableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.cfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ids.rule)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnDemand) }),
            };
            if (onDemandScope != null)
                rule[Q(SchemaNames.Rule.OnDemandScope)] = onDemandScope;

            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)Ascentix.RulesEngine.Core.Models.LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
            };
            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), ids.cond)
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.IsNotNull),
            };
            var updateAction = new Entity(Q(SchemaNames.RuleAction.Entity), ids.updateAct)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.UpdateRecord),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                [Q(SchemaNames.RuleAction.TargetNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                [Q(SchemaNames.RuleAction.FieldMapping)] = "[{\"target\":\"description\",\"source\":\"literal\",\"value\":\"applied\"}]",
                [Q(SchemaNames.RuleAction.Order)] = 1,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };
            var blockAction = new Entity(Q(SchemaNames.RuleAction.Entity), ids.blockAct)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnNoMatch),
                [Q(SchemaNames.RuleAction.Message)] = "Needs a name",
                [Q(SchemaNames.RuleAction.Order)] = 2,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };
            return (new List<Entity> { tableConfig, rule, group, condition, updateAction, blockAction }, ids.rule);
        }

        private static XrmFakedPluginExecutionContext ApiContext(ParameterCollection input)
            => new XrmFakedPluginExecutionContext
            {
                MessageName = SchemaNames.ApplyRulesApi.MessageName,
                Stage = 30, // main operation
                InputParameters = input,
                OutputParameters = new ParameterCollection()
            };

        private static ParameterCollection Input(Guid ruleId, Guid recordId) => new ParameterCollection
        {
            { SchemaNames.ApplyRulesApi.ParamRuleId, ruleId.ToString() },
            { SchemaNames.ApplyRulesApi.ParamRecordId, recordId.ToString() },
        };

        [Fact]
        public void A_matching_record_is_updated_and_the_write_is_counted()
        {
            var ctx = new XrmFakedContext();
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new FakeAttributeMetadataExecutor("account", new StringAttributeMetadata { LogicalName = "description" }));
            var (seed, ruleId) = Seed();
            var recordId = Guid.NewGuid();
            seed.Add(new Entity("account", recordId) { ["name"] = "Acme" });
            ctx.Initialize(seed);

            var pctx = ApiContext(Input(ruleId, recordId));
            ctx.ExecutePluginWith<ApplyRulesApi>(pctx);

            Assert.True((bool)pctx.OutputParameters[SchemaNames.ApplyRulesApi.PropIsValid]);
            Assert.Equal(1, (int)pctx.OutputParameters[SchemaNames.ApplyRulesApi.PropWriteCount]);

            var updated = ctx.GetOrganizationService().Retrieve("account", recordId, new ColumnSet("description"));
            Assert.Equal("applied", updated["description"]);
        }

        [Fact]
        public void A_block_throws_the_rendered_message_and_writes_nothing()
        {
            var ctx = new XrmFakedContext();
            var (seed, ruleId) = Seed();
            var recordId = Guid.NewGuid();
            seed.Add(new Entity("account", recordId)); // no name -> no match -> Block
            ctx.Initialize(seed);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<ApplyRulesApi>(ApiContext(Input(ruleId, recordId))));
            Assert.Contains("Needs a name", ex.Message);

            var untouched = ctx.GetOrganizationService().Retrieve("account", recordId, new ColumnSet("description"));
            Assert.False(untouched.Contains("description"));
        }

        [Fact]
        public void A_record_that_does_not_exist_is_refused()
        {
            var ctx = new XrmFakedContext();
            var (seed, ruleId) = Seed();
            ctx.Initialize(seed);

            var recordId = Guid.NewGuid(); // never persisted

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<ApplyRulesApi>(ApiContext(Input(ruleId, recordId))));
            Assert.Contains($"Record {recordId} was not found in account.", ex.Message);
        }

        [Fact]
        public void A_rule_without_on_demand_is_refused()
        {
            var ctx = new XrmFakedContext();
            var ids = (rule: Guid.NewGuid(), cfg: Guid.NewGuid());
            var tableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.cfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ids.rule)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
            };
            ctx.Initialize(new List<Entity> { tableConfig, rule });

            var recordId = Guid.NewGuid();

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<ApplyRulesApi>(ApiContext(Input(ids.rule, recordId))));
            Assert.Contains("The rule is not published with the On demand trigger.", ex.Message);
        }

        [Fact]
        public void A_given_or_all_records_rule_both_accept_one_record()
        {
            var ctx = new XrmFakedContext();
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new FakeAttributeMetadataExecutor("account", new StringAttributeMetadata { LogicalName = "description" }));
            var (seed, ruleId) = Seed(new OptionSetValue((int)OnDemandScope.AllRecords));
            var recordId = Guid.NewGuid();
            seed.Add(new Entity("account", recordId) { ["name"] = "Acme" });
            ctx.Initialize(seed);

            var pctx = ApiContext(Input(ruleId, recordId));
            ctx.ExecutePluginWith<ApplyRulesApi>(pctx);

            Assert.True((bool)pctx.OutputParameters[SchemaNames.ApplyRulesApi.PropIsValid]);
            Assert.Equal(1, (int)pctx.OutputParameters[SchemaNames.ApplyRulesApi.PropWriteCount]);
        }
    }
}
