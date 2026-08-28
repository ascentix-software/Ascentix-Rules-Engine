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
    public class TableRuleAnalyzerTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // Root-only rule on "account": name == "Valid", Block OnNoMatch, tagged with `trigger`.
        private static List<Entity> SeedAccountRule(int trigger, ActionType actionType, bool actionActive = true)
        {
            var ruleId = Guid.NewGuid();
            var cfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();
            var actId = Guid.NewGuid();

            return new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), cfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue(trigger) }),
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
                    [Q(SchemaNames.RuleAction.IsActive)] = actionActive,
                },
            };
        }

        // Root-only rule on "sample_order": name == "Valid", tagged with asx_triggercolumns
        // declaring "sample_lineamount" (a column no condition otherwise references).
        private static List<Entity> SeedSampleOrderRuleWithTriggerColumns(string triggerColumnsJson)
        {
            var ruleId = Guid.NewGuid();
            var cfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();

            return new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), cfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_order",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                    [Q(SchemaNames.Rule.TriggerColumns)] = triggerColumnsJson,
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
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), cfgId),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                    [Q(SchemaNames.RuleCondition.ComparisonValue)] = "Valid",
                },
            };
        }

        [Fact]
        public void RootColumns_includes_declared_trigger_columns_not_referenced_by_any_condition()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(SeedSampleOrderRuleWithTriggerColumns("[\"sample_lineamount\"]"));
            var analyses = new TableRuleAnalyzer(ctx.GetOrganizationService()).Analyze("sample_order", null);

            var a = Assert.Single(analyses);
            Assert.Contains("name", a.RootColumns);
            Assert.Contains("sample_lineamount", a.RootColumns);
        }

        [Fact]
        public void Analyzes_a_root_only_block_rule_as_server_relevant_on_update()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(SeedAccountRule((int)RuleTrigger.OnUpdate, ActionType.Block));
            var analyses = new TableRuleAnalyzer(ctx.GetOrganizationService()).Analyze("account", null);

            var a = Assert.Single(analyses);
            Assert.True(a.HasServerAction);
            Assert.True(a.OnUpdate);
            Assert.False(a.OnCreate);
            Assert.True(a.IsRootOnly);
            Assert.Contains("name", a.RootColumns);
        }

        [Fact]
        public void A_client_only_rule_is_not_server_relevant()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(SeedAccountRule((int)RuleTrigger.OnUpdate, ActionType.ShowMessage));
            var analyses = new TableRuleAnalyzer(ctx.GetOrganizationService()).Analyze("account", null);

            Assert.False(Assert.Single(analyses).HasServerAction);
        }

        [Fact]
        public void An_inactive_block_action_is_not_server_relevant()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(SeedAccountRule((int)RuleTrigger.OnUpdate, ActionType.Block, actionActive: false));
            var analyses = new TableRuleAnalyzer(ctx.GetOrganizationService()).Analyze("account", null);

            Assert.False(Assert.Single(analyses).HasServerAction);
        }

        // A hand-created / half-saved action row can have no asx_actiontype at all. The
        // analyzer runs on every publish/reconcile of the table, so it must skip such a row
        // rather than throw (one bad row would otherwise block every later save on the table).
        [Fact]
        public void An_action_with_a_null_action_type_is_ignored_and_does_not_block_analysis()
        {
            var seed = SeedAccountRule((int)RuleTrigger.OnUpdate, ActionType.ShowMessage);
            var ruleId = seed.Single(e => e.LogicalName == Q(SchemaNames.Rule.Entity)).Id;
            seed.Add(new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                // asx_actiontype deliberately omitted (null)
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnNoMatch),
                [Q(SchemaNames.RuleAction.Order)] = 2,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            });
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);

            var analyses = new TableRuleAnalyzer(ctx.GetOrganizationService()).Analyze("account", null);

            // Returns normally; the typeless action contributes nothing (sibling is client-only).
            var a = Assert.Single(analyses);
            Assert.False(a.HasServerAction);
            Assert.True(a.OnUpdate);
        }

        [Fact]
        public void A_null_action_type_sibling_does_not_hide_a_valid_block_action()
        {
            var seed = SeedAccountRule((int)RuleTrigger.OnUpdate, ActionType.Block);
            var ruleId = seed.Single(e => e.LogicalName == Q(SchemaNames.Rule.Entity)).Id;
            seed.Add(new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                // asx_actiontype deliberately omitted (null)
                [Q(SchemaNames.RuleAction.Order)] = 2,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            });
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);

            var analyses = new TableRuleAnalyzer(ctx.GetOrganizationService()).Analyze("account", null);

            // The valid sibling Block action is still counted.
            Assert.True(Assert.Single(analyses).HasServerAction);
        }
    }
}
