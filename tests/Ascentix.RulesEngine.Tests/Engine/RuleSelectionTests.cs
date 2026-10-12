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

namespace Ascentix.RulesEngine.Tests.Engine
{
    /// <summary>
    /// A <see cref="RuleSelection"/> narrows an On demand run to one rule and/or every channel.
    /// Four account rules, trigger OnDemand, each with one condition that never matches:
    /// A and B (no channel restriction), C (Portal only), D (its one group is an execution
    /// condition, so it never even reaches a match decision).
    /// </summary>
    public class RuleSelectionTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private static readonly Guid AccountId = Guid.NewGuid();
        private static readonly Guid RuleA = Guid.NewGuid();
        private static readonly Guid RuleB = Guid.NewGuid();
        private static readonly Guid RuleC = Guid.NewGuid();
        private static readonly Guid RuleD = Guid.NewGuid();

        // account.name equals "never" (never true for the seeded "Acme" record); Block that fires when the outcome is false
        // whose message is the rule's own name, unless suppressed (rule D fires nothing: its group
        // is an execution condition, so the rule never reaches a match decision).
        private static List<Entity> SeedRule(Guid ruleId, string name, bool isExecutionCondition,
            RuleChannel? onlyChannel = null, bool withBlockAction = true)
        {
            var cfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();

            var tableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), cfgId)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ruleId)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnDemand) }),
            };
            if (onlyChannel.HasValue)
                rule[Q(SchemaNames.Rule.Channels)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)onlyChannel.Value) });

            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = isExecutionCondition,
            };
            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), condId)
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), cfgId),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                [Q(SchemaNames.RuleCondition.ComparisonValue)] = "never",
            };

            var entities = new List<Entity> { tableConfig, rule, group, condition };
            if (withBlockAction)
            {
                var actionId = Guid.NewGuid();
                entities.Add(new Entity(Q(SchemaNames.RuleAction.Entity), actionId)
                {
                    [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                    [Q(SchemaNames.RuleAction.Message)] = name,
                    [Q(SchemaNames.RuleAction.Order)] = 1,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                });
                entities.AddRange(ActionTreeRows.AnyFalse(actionId, grpId));
            }
            return entities;
        }

        private static RuleEvaluationOutcome Run(RuleSelection selection)
        {
            var entities = new List<Entity> { new Entity("account", AccountId) { ["name"] = "Acme" } };
            entities.AddRange(SeedRule(RuleA, "A", isExecutionCondition: false));
            entities.AddRange(SeedRule(RuleB, "B", isExecutionCondition: false));
            entities.AddRange(SeedRule(RuleC, "C", isExecutionCondition: false, onlyChannel: RuleChannel.Portal));
            entities.AddRange(SeedRule(RuleD, "D", isExecutionCondition: true, withBlockAction: false));

            var ctx = new XrmFakedContext();
            ctx.Initialize(entities);
            var service = ctx.GetOrganizationService();

            return new RulesEngineRunner().Run(service, service, "account",
                new List<RootInput> { new RootInput { Id = AccountId, Overlay = null } },
                RuleTrigger.OnDemand, RuleChannel.Standard, 1033, RootBuildMode.RetrieveOnly,
                new XrmFakedTracingService(), selection);
        }

        [Fact]
        public void A_rule_id_selection_runs_only_that_rule()
        {
            var outcome = Run(new RuleSelection { RuleId = RuleA });
            Assert.Equal(new[] { "A" }, outcome.BlockingMessages.ToArray());
        }

        [Fact]
        public void Without_any_channel_a_portal_only_rule_does_not_run_on_standard()
        {
            var outcome = Run(new RuleSelection { RuleId = RuleC });
            Assert.Empty(outcome.BlockingMessages);
        }

        [Fact]
        public void Any_channel_runs_a_portal_only_rule()
        {
            var outcome = Run(new RuleSelection { RuleId = RuleC, AnyChannel = true });
            Assert.Equal(new[] { "C" }, outcome.BlockingMessages.ToArray());
        }

        [Fact]
        public void No_selection_keeps_todays_behavior()
        {
            var outcome = Run(null);
            Assert.Equal(new[] { "A", "B" }, outcome.BlockingMessages.OrderBy(m => m).ToArray());
        }

        [Fact]
        public void A_record_whose_execution_conditions_fail_reports_the_rule_as_gated()
        {
            var outcome = Run(new RuleSelection { RuleId = RuleD });
            Assert.Equal(new[] { RuleD }, outcome.Records[0].GatedRuleIds.ToArray());
            Assert.Empty(outcome.Records[0].FiredActions);
        }
    }
}
