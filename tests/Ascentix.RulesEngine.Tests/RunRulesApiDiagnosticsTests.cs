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
    public class RunRulesApiDiagnosticsTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // Published account rule: name IsNotNull → Block OnMatch (always fires when name present).
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
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.IsNotNull),
            };
            var action = new Entity(Q(SchemaNames.RuleAction.Entity), ids.act)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                [Q(SchemaNames.RuleAction.Message)] = "blocked",
                [Q(SchemaNames.RuleAction.Order)] = 1,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };
            return new List<Entity> { tableConfig, rule, group, condition, action };
        }

        private static XrmFakedPluginExecutionContext ApiContext(ParameterCollection input)
            => new XrmFakedPluginExecutionContext
            {
                MessageName = "asx_RunRules",
                Stage = 30,
                InputParameters = input,
                OutputParameters = new ParameterCollection()
            };

        [Fact]
        public void IncludeDiagnostics_true_outputs_diagnostics_json_with_totalMs()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());

            var input = new ParameterCollection
            {
                { "TableName", "account" },
                { "RecordJson", "{\"name\":\"Acme\"}" },
                { "Triggers", "Manual" },
                { "IncludeDiagnostics", true },
            };

            var pctx = ApiContext(input);
            ctx.ExecutePluginWith<RunRulesApi>(pctx);

            var output = pctx.OutputParameters;
            Assert.True(output.Contains("Diagnostics") && !string.IsNullOrEmpty((string)output["Diagnostics"]));
            Assert.Contains("totalMs", (string)output["Diagnostics"]);
        }

        [Fact]
        public void IncludeDiagnostics_omitted_does_not_output_diagnostics()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());

            var input = new ParameterCollection
            {
                { "TableName", "account" },
                { "RecordJson", "{\"name\":\"Acme\"}" },
                { "Triggers", "Manual" },
                // IncludeDiagnostics intentionally omitted
            };

            var pctx = ApiContext(input);
            ctx.ExecutePluginWith<RunRulesApi>(pctx);

            var output = pctx.OutputParameters;
            Assert.True(!output.ContainsKey("Diagnostics") || string.IsNullOrEmpty(output["Diagnostics"] as string));
        }

        [Fact]
        public void IncludeDiagnostics_false_does_not_output_diagnostics()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());

            var input = new ParameterCollection
            {
                { "TableName", "account" },
                { "RecordJson", "{\"name\":\"Acme\"}" },
                { "Triggers", "Manual" },
                { "IncludeDiagnostics", false },
            };

            var pctx = ApiContext(input);
            ctx.ExecutePluginWith<RunRulesApi>(pctx);

            var output = pctx.OutputParameters;
            Assert.True(!output.ContainsKey("Diagnostics") || string.IsNullOrEmpty(output["Diagnostics"] as string));
        }
    }
}
