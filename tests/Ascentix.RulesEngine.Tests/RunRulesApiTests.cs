using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RunRulesApiTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // account.name must equal "Valid"; Block OnNoMatch; tagged Manual.
        private static List<Entity> Seed()
        {
            var ids = (rule: Guid.NewGuid(), cfg: Guid.NewGuid(), grp: Guid.NewGuid(),
                       cond: Guid.NewGuid(), act: Guid.NewGuid());
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
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.Manual) }),
            };
            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
            };
            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), ids.cond)
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                [Q(SchemaNames.RuleCondition.ComparisonValue)] = "Valid",
            };
            var action = new Entity(Q(SchemaNames.RuleAction.Entity), ids.act)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnNoMatch),
                [Q(SchemaNames.RuleAction.Message)] = "Name must be Valid.",
                [Q(SchemaNames.RuleAction.Order)] = 1,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };
            return new List<Entity> { tableConfig, rule, group, condition, action };
        }

        private static XrmFakedPluginExecutionContext ApiContext(ParameterCollection input)
            => new XrmFakedPluginExecutionContext
            {
                MessageName = "asx_RunRules",
                Stage = 30, // main operation
                InputParameters = input,
                OutputParameters = new ParameterCollection()
            };

        [Fact]
        public void RecordJson_failing_rule_reports_invalid_with_results()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());

            var input = new ParameterCollection
            {
                { "TableName", "account" },
                { "RecordJson", "{\"name\":\"Invalid\"}" },
                { "Triggers", "Manual" },
            };

            // Hold the context: its OutputParameters is the same instance the plugin writes to,
            // so we read it directly rather than depending on ExecutePluginWith's return value.
            var pctx = ApiContext(input);
            ctx.ExecutePluginWith<RunRulesApi>(pctx);

            Assert.False((bool)pctx.OutputParameters["IsValid"]);
            Assert.Equal(1, (int)pctx.OutputParameters["FailedRuleCount"]);
            Assert.Contains("Name must be Valid.", (string)pctx.OutputParameters["Results"]);
        }

        [Fact]
        public void RecordJson_matching_rule_reports_valid_with_empty_results()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());

            var input = new ParameterCollection
            {
                { "TableName", "account" },
                { "RecordJson", "{\"name\":\"Valid\"}" },
            };

            var pctx = ApiContext(input);
            ctx.ExecutePluginWith<RunRulesApi>(pctx);

            Assert.True((bool)pctx.OutputParameters["IsValid"]);
            Assert.Equal(0, (int)pctx.OutputParameters["FailedRuleCount"]);
            Assert.Equal("[]", (string)pctx.OutputParameters["Results"]);
        }

        [Fact]
        public void RecordId_retrieves_persisted_record_and_evaluates()
        {
            var ctx = new XrmFakedContext();
            var id = Guid.NewGuid();
            var seed = Seed();
            seed.Add(new Entity("account", id) { ["name"] = "Invalid" }); // persisted, violates
            ctx.Initialize(seed);

            var input = new ParameterCollection
            {
                { "TableName", "account" },
                { "RecordId", id.ToString() },
            };

            var pctx = ApiContext(input);
            ctx.ExecutePluginWith<RunRulesApi>(pctx);

            Assert.False((bool)pctx.OutputParameters["IsValid"]);
        }

        [Fact]
        public void Missing_table_name_throws_argument_error()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());

            var input = new ParameterCollection { { "RecordJson", "{\"name\":\"x\"}" } };

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<RunRulesApi>(ApiContext(input)));
            Assert.Contains("TableName", ex.Message);
        }

        [Fact]
        public void Neither_record_id_nor_json_throws_argument_error()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());

            var input = new ParameterCollection { { "TableName", "account" } };

            Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<RunRulesApi>(ApiContext(input)));
        }

        [Fact]
        public void Unknown_trigger_throws_argument_error()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());

            var input = new ParameterCollection
            {
                { "TableName", "account" },
                { "RecordJson", "{\"name\":\"Valid\"}" },
                { "Triggers", "Nonsense" },
            };

            Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<RunRulesApi>(ApiContext(input)));
        }

        [Fact]
        public void RecordId_with_RecordJson_overlays_unsaved_values()
        {
            var ctx = new XrmFakedContext();
            var id = Guid.NewGuid();
            var seed = Seed();
            seed.Add(new Entity("account", id) { ["name"] = "Valid" }); // persisted PASSES
            ctx.Initialize(seed);

            // Overlay an unsaved name that VIOLATES the rule → overlay must win.
            var input = new ParameterCollection
            {
                { "TableName", "account" },
                { "RecordId", id.ToString() },
                { "RecordJson", "{\"name\":\"Invalid\"}" },
            };

            var pctx = ApiContext(input);
            ctx.ExecutePluginWith<RunRulesApi>(pctx);

            Assert.False((bool)pctx.OutputParameters["IsValid"]);
            Assert.Equal(1, (int)pctx.OutputParameters["FailedRuleCount"]);
        }
    }
}
