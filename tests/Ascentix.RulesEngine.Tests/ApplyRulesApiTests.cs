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

        // account.name is not null → Update Record (root) sets description = "applied" (fires when the outcome is true);
        // Block "Needs a name" (fires when the outcome is false); published, tagged OnDemand.
        private static (List<Entity> Seed, Guid RuleId) Seed(OptionSetValue onDemandScope = null,
            RuleEvaluationContext? evaluationContext = null, RuleStatus status = RuleStatus.Published)
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
                ["statuscode"] = new OptionSetValue((int)status),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnDemand) }),
            };
            if (onDemandScope != null)
                rule[Q(SchemaNames.Rule.OnDemandScope)] = onDemandScope;
            if (evaluationContext.HasValue)
                rule[Q(SchemaNames.Rule.EvaluationContext)] = new OptionSetValue((int)evaluationContext.Value);

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
                [Q(SchemaNames.RuleAction.TargetNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                [Q(SchemaNames.RuleAction.FieldMapping)] = "[{\"target\":\"description\",\"source\":\"literal\",\"value\":\"applied\"}]",
                [Q(SchemaNames.RuleAction.Order)] = 1,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };
            var blockAction = new Entity(Q(SchemaNames.RuleAction.Entity), ids.blockAct)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                [Q(SchemaNames.RuleAction.Message)] = "Needs a name",
                [Q(SchemaNames.RuleAction.Order)] = 2,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };
            return (new List<Entity> { tableConfig, rule, group, condition, updateAction, blockAction,
                ActionTreeRows.AllTrue(ids.updateAct, ids.grp), ActionTreeRows.AnyFalse(ids.blockAct, ids.grp) }, ids.rule);
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
            Assert.Contains($"Record {recordId} was not found in account, or you can't read it.", ex.Message);
        }

        [Fact]
        public void A_record_the_caller_cannot_read_is_refused_for_a_user_context_rule()
        {
            var ctx = new CallerServiceContext();
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new FakeAttributeMetadataExecutor("account", new StringAttributeMetadata { LogicalName = "description" }));
            var (seed, ruleId) = Seed();
            var recordId = Guid.NewGuid();
            seed.Add(new Entity("account", recordId) { ["name"] = "Acme" });
            ctx.Initialize(seed);
            var user = new HiddenRowService(ctx.GetOrganizationService(), recordId);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecuteAs<ApplyRulesApi>(ApiContext(Input(ruleId, recordId)), user));

            Assert.Equal($"Record {recordId} was not found in account, or you can't read it.", ex.Message);
            var untouched = ctx.GetOrganizationService().Retrieve("account", recordId, new ColumnSet("description"));
            Assert.False(untouched.Contains("description"));
        }

        [Fact]
        public void A_system_context_rule_applies_to_a_record_the_caller_cannot_read()
        {
            var ctx = new CallerServiceContext();
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new FakeAttributeMetadataExecutor("account", new StringAttributeMetadata { LogicalName = "description" }));
            var (seed, ruleId) = Seed(evaluationContext: RuleEvaluationContext.System);
            var recordId = Guid.NewGuid();
            seed.Add(new Entity("account", recordId) { ["name"] = "Acme" });
            ctx.Initialize(seed);
            var user = new HiddenRowService(ctx.GetOrganizationService(), recordId);

            var pctx = ApiContext(Input(ruleId, recordId));
            ctx.ExecuteAs<ApplyRulesApi>(pctx, user);

            Assert.Equal(1, (int)pctx.OutputParameters[SchemaNames.ApplyRulesApi.PropWriteCount]);
            var updated = ctx.GetOrganizationService().Retrieve("account", recordId, new ColumnSet("description"));
            Assert.Equal("applied", updated["description"]);
        }

        [Fact]
        public void An_unpublished_rule_is_refused()
        {
            var ctx = new XrmFakedContext();
            var (seed, ruleId) = Seed(status: RuleStatus.Draft);
            var recordId = Guid.NewGuid();
            seed.Add(new Entity("account", recordId) { ["name"] = "Acme" });
            ctx.Initialize(seed);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<ApplyRulesApi>(ApiContext(Input(ruleId, recordId))));

            Assert.Equal("The rule is not published with the On demand trigger.", ex.Message);
            var untouched = ctx.GetOrganizationService().Retrieve("account", recordId, new ColumnSet("description"));
            Assert.False(untouched.Contains("description"));
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

        [Fact]
        public void With_IncludeDiagnostics_the_api_returns_the_evaluation_and_write_diagnostics()
        {
            var ctx = new XrmFakedContext();
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new FakeAttributeMetadataExecutor("account", new StringAttributeMetadata { LogicalName = "description" }));
            var (seed, ruleId) = Seed();
            var recordId = Guid.NewGuid();
            seed.Add(new Entity("account", recordId) { ["name"] = "Acme" });
            ctx.Initialize(seed);

            var input = Input(ruleId, recordId);
            input[SchemaNames.ApplyRulesApi.ParamIncludeDiagnostics] = true;
            var pctx = ApiContext(input);
            ctx.ExecutePluginWith<ApplyRulesApi>(pctx);

            var json = (string)pctx.OutputParameters[SchemaNames.ApplyRulesApi.PropDiagnostics];
            Assert.Contains("\"totalMs\":", json);
            Assert.Contains("\"ruleLoad\"", json);
            Assert.Contains("\"changeSetBuild\"", json);
            Assert.Contains("\"writesSent\":1", json);
            Assert.Contains("\"singleRequests\":1", json);
        }

        [Fact]
        public void ApplyRules_without_IncludeDiagnostics_sets_no_Diagnostics()
        {
            var ctx = new XrmFakedContext();
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new FakeAttributeMetadataExecutor("account", new StringAttributeMetadata { LogicalName = "description" }));
            var (seed, ruleId) = Seed();
            var recordId = Guid.NewGuid();
            seed.Add(new Entity("account", recordId) { ["name"] = "Acme" });
            ctx.Initialize(seed);

            var pctx = ApiContext(Input(ruleId, recordId));
            ctx.ExecutePluginWith<ApplyRulesApi>(pctx);

            Assert.False(pctx.OutputParameters.ContainsKey(SchemaNames.ApplyRulesApi.PropDiagnostics));
        }
    }
}
