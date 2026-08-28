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
    public class ReadRulesApiTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // account rule tagged with `trigger`; one root FieldComparison (name == "Valid"); Block OnNoMatch.
        private static List<Entity> Seed(RuleTrigger trigger)
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
                [Q(SchemaNames.PrimaryName)] = "Name must be Valid",
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)trigger) }),
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
                MessageName = "asx_ReadRules",
                Stage = 30,
                InputParameters = input,
                OutputParameters = new ParameterCollection()
            };

        [Fact]
        public void Default_trigger_onform_returns_rule_definition()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed(RuleTrigger.OnForm));

            var pctx = ApiContext(new ParameterCollection { { "TableName", "account" } });
            ctx.ExecutePluginWith<ReadRulesApi>(pctx);

            var json = (string)pctx.OutputParameters["Rules"];
            Assert.Contains("\"tableLogicalName\":\"account\"", json);
            Assert.Contains("\"comparisonColumn\":\"name\"", json);
            Assert.Contains("\"tableConfigType\":\"RootTable\"", json);
            Assert.Contains("\"actionType\":\"Block\"", json);
            Assert.Contains("\"message\":\"Name must be Valid.\"", json);
        }

        [Fact]
        public void Explicit_onform_trigger_returns_rule_definition()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed(RuleTrigger.OnForm));

            var pctx = ApiContext(new ParameterCollection { { "TableName", "account" }, { "Triggers", "OnForm" } });
            ctx.ExecutePluginWith<ReadRulesApi>(pctx);

            Assert.Contains("\"actionType\":\"Block\"", (string)pctx.OutputParameters["Rules"]);
        }

        [Fact]
        public void Rule_not_tagged_for_trigger_is_excluded()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed(RuleTrigger.Manual)); // only Manual; default request trigger is OnForm

            var pctx = ApiContext(new ParameterCollection { { "TableName", "account" } });
            ctx.ExecutePluginWith<ReadRulesApi>(pctx);

            Assert.Contains("\"rules\":[]", (string)pctx.OutputParameters["Rules"]);
        }

        [Fact]
        public void No_rules_returns_empty_array_envelope()
        {
            var ctx = new XrmFakedContext(); // nothing seeded

            var pctx = ApiContext(new ParameterCollection { { "TableName", "account" } });
            ctx.ExecutePluginWith<ReadRulesApi>(pctx);

            var json = (string)pctx.OutputParameters["Rules"];
            Assert.Contains("\"tableLogicalName\":\"account\"", json);
            Assert.Contains("\"rules\":[]", json);
        }

        [Fact]
        public void Missing_table_name_throws_argument_error()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed(RuleTrigger.OnForm));

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<ReadRulesApi>(ApiContext(new ParameterCollection())));
            Assert.Contains("TableName", ex.Message);
        }

        [Fact]
        public void Unknown_trigger_throws_argument_error()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed(RuleTrigger.OnForm));

            var input = new ParameterCollection { { "TableName", "account" }, { "Triggers", "Nonsense" } };
            Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<ReadRulesApi>(ApiContext(input)));
        }

        [Fact]
        public void Child_node_rowcount_rule_serializes_child_table_config()
        {
            var ctx = new XrmFakedContext();
            var ids = (rule: Guid.NewGuid(), rootcfg: Guid.NewGuid(), childcfg: Guid.NewGuid(),
                       grp: Guid.NewGuid(), cond: Guid.NewGuid());

            var rootCfg = new Entity(Q(SchemaNames.TableConfig.Entity), ids.rootcfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            var childCfg = new Entity(Q(SchemaNames.TableConfig.Entity), ids.childcfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "contact",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.rootcfg),
                [Q(SchemaNames.TableConfig.ChildLinkField)] = "parentcustomerid",
            };
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ids.rule)
            {
                [Q(SchemaNames.PrimaryName)] = "Child rowcount",
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnForm) }),
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
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.childcfg),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.RowCount),
                [Q(SchemaNames.RuleCondition.MinExpectedRows)] = 1,
                [Q(SchemaNames.RuleCondition.MaxExpectedRows)] = 5,
            };
            ctx.Initialize(new List<Entity> { rootCfg, childCfg, rule, group, condition });

            var pctx = ApiContext(new ParameterCollection { { "TableName", "account" } });
            ctx.ExecutePluginWith<ReadRulesApi>(pctx);

            var json = (string)pctx.OutputParameters["Rules"];
            Assert.Contains("\"conditionType\":\"RowCount\"", json);
            Assert.Contains("\"tableConfigType\":\"ChildTable\"", json);
            Assert.Contains("\"minExpectedRows\":1", json);
            Assert.Contains("\"maxExpectedRows\":5", json);
        }
    }
}
