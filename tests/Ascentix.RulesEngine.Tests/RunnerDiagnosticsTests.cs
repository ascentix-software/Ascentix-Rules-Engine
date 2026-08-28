using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using CoreModels = Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RunnerDiagnosticsTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // An always-true root rule (name IsNotNull) with a Block action. ctx sets the rule's
        // asx_evaluationcontext (null = leave unset → User).
        private static List<Entity> Seed(RuleEvaluationContext? ctx = null)
        {
            var ids = (rule: Guid.NewGuid(), cfg: Guid.NewGuid(), grp: Guid.NewGuid(), cond: Guid.NewGuid(), act: Guid.NewGuid());
            var cfg = new Entity(Q(SchemaNames.TableConfig.Entity), ids.cfg)
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
            if (ctx.HasValue)
                rule[Q(SchemaNames.Rule.EvaluationContext)] = new OptionSetValue((int)ctx.Value);
            var grp = new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
            };
            var cond = new Entity(Q(SchemaNames.RuleCondition.Entity), ids.cond)
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.IsNotNull),
            };
            var act = new Entity(Q(SchemaNames.RuleAction.Entity), ids.act)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                [Q(SchemaNames.RuleAction.Message)] = "blocked",
                [Q(SchemaNames.RuleAction.IsActive)] = true,
                [Q(SchemaNames.RuleAction.Order)] = 1,
            };
            return new List<Entity> { cfg, rule, grp, cond, act };
        }

        [Fact]
        public void Run_populates_diagnostics_with_stages_and_counts()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme" };

            var outcome = new RulesEngineRunner().Run(
                ctx.GetOrganizationService(), ctx.GetOrganizationService(),
                "account", new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                RuleTrigger.OnCreate, RuleChannel.Standard, 1033, RootBuildMode.UseTarget,
                new XrmFakedTracingService());

            Assert.NotNull(outcome.Diagnostics);
            Assert.Equal(1, outcome.Diagnostics.RulesLoaded);
            Assert.Equal(1, outcome.Diagnostics.RulesEvaluated);
            Assert.Equal(1, outcome.Diagnostics.RulesFired);
            Assert.Contains(outcome.Diagnostics.Stages, s => s.Name == "ruleLoad");
            Assert.Contains(outcome.Diagnostics.Stages, s => s.Name == "evaluate");
        }

        // Golden: the stage-name SET the asx_RunRules diagnostics attribute serializes (and
        // client/test-dev subjects.ts reads) is exactly these nine, none renamed, added or
        // dropped by the gather / evaluate / dispatch split. Two buckets (one User rule, one
        // System rule) so every per-bucket stage accumulates twice under one name.
        [Fact]
        public void Run_with_two_buckets_reports_exactly_the_nine_stage_names()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed(RuleEvaluationContext.User).Concat(Seed(RuleEvaluationContext.System)).ToList());
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme" };

            var outcome = new RulesEngineRunner().Run(
                ctx.GetOrganizationService(), ctx.GetOrganizationService(),
                "account", new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                RuleTrigger.OnCreate, RuleChannel.Standard, 1033, RootBuildMode.UseTarget,
                new XrmFakedTracingService());

            Assert.Equal(2, outcome.Diagnostics.RulesEvaluated);
            Assert.Equal(2, outcome.Diagnostics.RulesFired);
            Assert.Equal(2, outcome.Records.Single().FiredActions.Count);

            var names = outcome.Diagnostics.Stages.Select(s => s.Name).ToList();
            Assert.Equal(names.Count, names.Distinct().Count());
            Assert.Equal(
                new HashSet<string>
                {
                    "ruleLoad", "scheduleFilter", "conditionMap", "actionLoad", "tableConfigLoad",
                    "planBuild", "rootBuild", "queryExecute", "evaluate",
                },
                new HashSet<string>(names));
        }
    }
}
