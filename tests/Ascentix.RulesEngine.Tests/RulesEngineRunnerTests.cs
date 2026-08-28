using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RulesEngineRunnerTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // account.name must equal "Valid"; Block OnNoMatch "Name must be Valid.".
        // ctx lets the caller set the rule's asx_evaluationcontext (null = leave unset → User).
        private static List<Entity> Seed(RuleEvaluationContext? ctx = null)
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
            if (ctx.HasValue)
                rule[Q(SchemaNames.Rule.EvaluationContext)] = new OptionSetValue((int)ctx.Value);

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

        private static RuleEvaluationOutcome Run(XrmFakedContext ctx, Entity overlay)
        {
            var service = ctx.GetOrganizationService();
            return new RulesEngineRunner().Run(
                systemService: service,
                userService: service,
                logicalName: "account",
                inputs: new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                trigger: RuleTrigger.Manual,
                channel: RuleChannel.Standard,
                languageId: 1033,
                buildMode: RootBuildMode.UseTarget,
                trace: new XrmFakedTracingService());
        }

        [Fact]
        public void System_context_rule_is_evaluated_and_blocks()
        {
            // A rule explicitly marked System still evaluates (here systemService == userService).
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed(RuleEvaluationContext.System));
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Invalid" };

            var outcome = Run(ctx, overlay);

            Assert.False(outcome.IsValid);
            Assert.Equal("Name must be Valid.", outcome.Records.Single().FiredActions.Single().Message);
        }

        [Fact]
        public void Returns_one_empty_record_when_no_rules()
        {
            var ctx = new XrmFakedContext(); // no rules seeded
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "whatever" };

            var outcome = Run(ctx, overlay);

            Assert.True(outcome.IsValid);
            Assert.Equal(0, outcome.FailedRuleCount);
            Assert.Empty(outcome.Records.Single().FiredActions);
            Assert.Equal(overlay.Id, outcome.Records.Single().RecordId);
        }
    }
}
