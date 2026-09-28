using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleRunPluginTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // Published account rules, legacy (no publishedrevision), loaded live by RuleBuckets like
        // RunRulesApiTests. "All": On demand, all-records scope. "Given": On demand, given-records
        // scope (the default). "Save": On create only, not runnable on demand.
        private static (List<Entity> Seed, Guid All, Guid Given, Guid Save) Seed()
        {
            var allId = Guid.NewGuid();
            var givenId = Guid.NewGuid();
            var saveId = Guid.NewGuid();

            var all = new Entity(Q(SchemaNames.Rule.Entity), allId)
            {
                [Q(SchemaNames.PrimaryName)] = "All",
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnDemand) }),
                [Q(SchemaNames.Rule.OnDemandScope)] = new OptionSetValue((int)OnDemandScope.AllRecords),
            };
            var given = new Entity(Q(SchemaNames.Rule.Entity), givenId)
            {
                [Q(SchemaNames.PrimaryName)] = "Given",
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnDemand) }),
                [Q(SchemaNames.Rule.OnDemandScope)] = new OptionSetValue((int)OnDemandScope.GivenRecord),
            };
            var save = new Entity(Q(SchemaNames.Rule.Entity), saveId)
            {
                [Q(SchemaNames.PrimaryName)] = "Save",
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
            };

            return (new List<Entity> { all, given, save }, allId, givenId, saveId);
        }

        private static Entity Run(Guid ruleId, string recordIdsJson = null)
        {
            var run = new Entity(Q(SchemaNames.RuleRun.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleRun.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
            };
            if (recordIdsJson != null) run[Q(SchemaNames.RuleRun.RecordIds)] = recordIdsJson;
            return run;
        }

        private static XrmFakedPluginExecutionContext RunContext(Entity run)
            => new XrmFakedPluginExecutionContext
            {
                MessageName = "Create",
                Stage = 20, // pre-operation
                PrimaryEntityName = Q(SchemaNames.RuleRun.Entity),
                InputParameters = new ParameterCollection { { "Target", run } },
            };

        [Fact]
        public void An_all_records_rule_without_record_ids_is_queued_as_an_all_records_run()
        {
            var (seed, allId, _, _) = Seed();
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);

            var run = Run(allId);
            ctx.ExecutePluginWith<RuleRunPlugin>(RunContext(run));

            Assert.Equal((int)RuleRunStatus.Queued, run.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleRun.Status)).Value);
            Assert.Equal((int)OnDemandScope.AllRecords, run.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleRun.Scope)).Value);
            Assert.Null(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.RecordIds)));
            Assert.Equal(0, run.GetAttributeValue<int>(Q(SchemaNames.RuleRun.Evaluated)));
            Assert.Equal(0, run.GetAttributeValue<int>(Q(SchemaNames.RuleRun.Changed)));
            Assert.Equal(0, run.GetAttributeValue<int>(Q(SchemaNames.RuleRun.Blocked)));
            Assert.Equal(0, run.GetAttributeValue<int>(Q(SchemaNames.RuleRun.Failed)));
            Assert.Equal(0, run.GetAttributeValue<int>(Q(SchemaNames.RuleRun.Skipped)));
            Assert.NotNull(run.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleRun.StartedOn)));
            Assert.StartsWith("All – ", run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.Name)));
        }

        [Fact]
        public void Record_ids_make_a_given_records_run_for_any_on_demand_rule()
        {
            var (seed, allId, _, _) = Seed();
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);

            var a = Guid.NewGuid();
            var b = Guid.NewGuid();
            var run = Run(allId, $"[\"{a}\",\"{b}\",\"{a}\"]");
            ctx.ExecutePluginWith<RuleRunPlugin>(RunContext(run));

            Assert.Equal((int)OnDemandScope.GivenRecord, run.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleRun.Scope)).Value);
            var ids = RunState.ParseRecordIds(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.RecordIds)));
            Assert.Equal(new[] { a, b }, ids.ToArray());
        }

        [Fact]
        public void A_given_records_rule_without_record_ids_is_refused()
        {
            var (seed, _, givenId, _) = Seed();
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);

            var run = Run(givenId);
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<RuleRunPlugin>(RunContext(run)));
            Assert.Equal("This rule runs for records it's given. Choose the records to run it for.", ex.Message);
        }

        [Fact]
        public void More_than_250_record_ids_are_refused()
        {
            var (seed, allId, _, _) = Seed();
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);

            var ids = Enumerable.Range(0, 251).Select(_ => Guid.NewGuid());
            var run = Run(allId, RunState.WriteRecordIds(ids));
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<RuleRunPlugin>(RunContext(run)));
            Assert.Equal("A run can include at most 250 records.", ex.Message);
        }

        [Fact]
        public void A_rule_without_the_on_demand_trigger_is_refused()
        {
            var (seed, _, _, saveId) = Seed();
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);

            var run = Run(saveId);
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<RuleRunPlugin>(RunContext(run)));
            Assert.Equal("The rule is not published with the On demand trigger.", ex.Message);
        }

        [Fact]
        public void A_second_active_run_for_the_same_rule_is_refused()
        {
            var (seed, allId, _, _) = Seed();
            seed.Add(new Entity(Q(SchemaNames.RuleRun.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleRun.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), allId),
                [Q(SchemaNames.RuleRun.Status)] = new OptionSetValue((int)RuleRunStatus.Running),
            });
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);

            var run = Run(allId);
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<RuleRunPlugin>(RunContext(run)));
            Assert.Equal("This rule already has a run in progress. Cancel or resume it first.", ex.Message);
        }

        [Fact]
        public void A_finished_run_does_not_block_a_new_one()
        {
            var (seed, allId, _, _) = Seed();
            seed.Add(new Entity(Q(SchemaNames.RuleRun.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleRun.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), allId),
                [Q(SchemaNames.RuleRun.Status)] = new OptionSetValue((int)RuleRunStatus.Completed),
            });
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);

            var run = Run(allId);
            ctx.ExecutePluginWith<RuleRunPlugin>(RunContext(run));

            Assert.Equal((int)RuleRunStatus.Queued, run.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleRun.Status)).Value);
        }
    }
}
