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
    public class ConditionMapperExpressionTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        [Fact]
        public void Maps_expression_condition_type_and_expression_string_onto_the_condition()
        {
            var ruleId = Guid.NewGuid();
            var rootCfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();
            const string expression = "sum(node:abc123.amount) > 1000";

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), condId)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.Expression),
                    [Q(SchemaNames.RuleCondition.ConditionExpression)] = expression,
                },
            });

            var rules = new RuleLoader(ctx.GetOrganizationService()).LoadRules("account");
            var groups = new ConditionGroupMapper().MapConditionGroups(rules);
            var condition = groups.Single().Conditions.Single();

            Assert.Equal(ConditionType.Expression, condition.ConditionType);
            Assert.Equal(expression, condition.Expression);
        }
    }
}
