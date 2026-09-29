using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Pre-operation Create/Update of asx_ruleschedule: one schedule per rule, field-shaped
    /// validation, the rule (or its open draft) must be an On demand/all-records rule when the
    /// schedule is on, a recognized time zone, and asx_nextrunon recomputed on the relevant
    /// changes. Outside asx_StartDueSchedules the engine-owned columns are never the caller's.
    /// </summary>
    public class RuleSchedulePluginTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private static Entity Rule(string name, RuleTrigger[] triggers, OnDemandScope? scope = null,
            string timeZone = null, Guid? id = null, Guid? draftOf = null)
        {
            var rule = new Entity(Q(SchemaNames.Rule.Entity), id ?? Guid.NewGuid())
            {
                [Q(SchemaNames.PrimaryName)] = name,
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    triggers.Select(t => new OptionSetValue((int)t)).ToList()),
            };
            if (scope != null) rule[Q(SchemaNames.Rule.OnDemandScope)] = new OptionSetValue((int)scope.Value);
            if (timeZone != null) rule[Q(SchemaNames.Rule.EvaluationTimeZone)] = timeZone;
            if (draftOf != null) rule[Q(SchemaNames.Rule.DraftOf)] = new EntityReference(Q(SchemaNames.Rule.Entity), draftOf.Value);
            return rule;
        }

        private static Entity Schedule(Guid? id = null, Guid? ruleId = null)
        {
            var schedule = new Entity(Q(SchemaNames.RuleSchedule.Entity), id ?? Guid.NewGuid());
            if (ruleId != null) schedule[Q(SchemaNames.RuleSchedule.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId.Value);
            return schedule;
        }

        private static XrmFakedPluginExecutionContext CreateContext(Entity target, XrmFakedPluginExecutionContext parent = null) =>
            new XrmFakedPluginExecutionContext
            {
                MessageName = "Create",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.RuleSchedule.Entity),
                InputParameters = new ParameterCollection { { "Target", target } },
                ParentContext = parent,
            };

        private static XrmFakedPluginExecutionContext UpdateContext(Entity target, XrmFakedPluginExecutionContext parent = null) =>
            new XrmFakedPluginExecutionContext
            {
                MessageName = "Update",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.RuleSchedule.Entity),
                InputParameters = new ParameterCollection { { "Target", target } },
                ParentContext = parent,
            };

        private static TransactionalPluginContext Context(params Entity[] seed)
        {
            var ctx = new TransactionalPluginContext();
            ctx.Initialize(new List<Entity>(seed));
            return ctx;
        }

        [Fact]
        public void A_valid_daily_schedule_gets_its_next_run()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords);
            var ctx = Context(rule);

            var schedule = Schedule(ruleId: rule.Id);
            schedule[Q(SchemaNames.RuleSchedule.On)] = true;
            schedule[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Daily);
            schedule[Q(SchemaNames.RuleSchedule.TimeOfDay)] = "02:00";

            ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule));

            var nextRun = schedule.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.NextRunOn));
            Assert.NotNull(nextRun);
            Assert.True(nextRun > DateTime.UtcNow);
            Assert.Equal(DateTimeKind.Utc, nextRun.Value.Kind);
            Assert.Equal("Test Rule schedule", schedule.GetAttributeValue<string>(Q(SchemaNames.RuleSchedule.Name)));
        }

        [Fact]
        public void A_second_schedule_for_the_same_rule_is_refused()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords);
            var existing = Schedule(ruleId: rule.Id);
            var ctx = Context(rule, existing);

            var schedule = Schedule(ruleId: rule.Id);
            schedule[Q(SchemaNames.RuleSchedule.On)] = false;

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule)));
            Assert.Equal(RuleSchedulePlugin.AlreadyScheduledMessage, ex.Message);
        }

        [Fact]
        public void Under_15_minutes_is_refused()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords);
            var ctx = Context(rule);

            var schedule = Schedule(ruleId: rule.Id);
            schedule[Q(SchemaNames.RuleSchedule.On)] = true;
            schedule[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.EveryMinutes);
            schedule[Q(SchemaNames.RuleSchedule.Every)] = 10;

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule)));
            Assert.Equal("Every N minutes must be 15, 30 or 45.", ex.Message);
        }

        [Fact]
        public void A_rule_without_on_demand_all_records_is_refused_when_on()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnCreate });
            var ctx = Context(rule);

            var schedule = Schedule(ruleId: rule.Id);
            schedule[Q(SchemaNames.RuleSchedule.On)] = true;
            schedule[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Daily);
            schedule[Q(SchemaNames.RuleSchedule.TimeOfDay)] = "02:00";

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule)));
            Assert.Equal(RuleSchedulePlugin.NotRunnableMessage, ex.Message);
        }

        [Fact]
        public void The_rules_open_draft_qualifies()
        {
            var active = Rule("Active Rule", new[] { RuleTrigger.OnCreate });
            var draft = Rule("Active Rule (draft)", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords, draftOf: active.Id);
            var ctx = Context(active, draft);

            var schedule = Schedule(ruleId: active.Id);
            schedule[Q(SchemaNames.RuleSchedule.On)] = true;
            schedule[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Daily);
            schedule[Q(SchemaNames.RuleSchedule.TimeOfDay)] = "02:00";

            ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule));

            Assert.NotNull(schedule.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.NextRunOn)));
        }

        [Fact]
        public void A_schedule_on_a_draft_row_is_refused()
        {
            var active = Rule("Active Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords);
            var draft = Rule("Active Rule (draft)", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords, draftOf: active.Id);
            var ctx = Context(active, draft);

            var schedule = Schedule(ruleId: draft.Id);
            schedule[Q(SchemaNames.RuleSchedule.On)] = false; // refused whether on or off

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule)));
            Assert.Equal("Schedules belong to the published rule.", ex.Message);
        }

        [Fact]
        public void Moving_a_schedule_onto_a_draft_row_is_refused()
        {
            var active = Rule("Active Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords);
            var draft = Rule("Active Rule (draft)", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords, draftOf: active.Id);
            var stored = Schedule(ruleId: active.Id);
            stored[Q(SchemaNames.RuleSchedule.On)] = false;
            var ctx = Context(active, draft, stored);

            var patch = Schedule(id: stored.Id, ruleId: draft.Id);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecuteTransactional<RuleSchedulePlugin>(UpdateContext(patch)));
            Assert.Equal(RuleSchedulePlugin.DraftRuleMessage, ex.Message);
        }

        [Fact]
        public void A_create_without_on_is_on_and_validated()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords);
            var ctx = Context(rule);

            var schedule = Schedule(ruleId: rule.Id);
            schedule[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Daily);
            schedule[Q(SchemaNames.RuleSchedule.TimeOfDay)] = "02:00";

            ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule));

            Assert.True(schedule.GetAttributeValue<bool>(Q(SchemaNames.RuleSchedule.On)));
            var nextRun = schedule.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.NextRunOn));
            Assert.NotNull(nextRun);
            Assert.True(nextRun > DateTime.UtcNow);
        }

        [Fact]
        public void A_create_without_on_still_gets_validation()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords);
            var ctx = Context(rule);

            var schedule = Schedule(ruleId: rule.Id);
            schedule[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.EveryMinutes);
            schedule[Q(SchemaNames.RuleSchedule.Every)] = 10;

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule)));
            Assert.Equal("Every N minutes must be 15, 30 or 45.", ex.Message);
        }

        [Fact]
        public void An_off_schedule_can_be_saved_on_any_rule()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnCreate });
            var ctx = Context(rule);

            var schedule = Schedule(ruleId: rule.Id);
            schedule[Q(SchemaNames.RuleSchedule.On)] = false;

            ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule));

            Assert.True(schedule.Contains(Q(SchemaNames.RuleSchedule.NextRunOn)));
            Assert.Null(schedule.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.NextRunOn)));
        }

        [Fact]
        public void An_unknown_time_zone_is_refused()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords, timeZone: "Mars Standard Time");
            var ctx = Context(rule);

            var schedule = Schedule(ruleId: rule.Id);
            schedule[Q(SchemaNames.RuleSchedule.On)] = true;
            schedule[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Daily);
            schedule[Q(SchemaNames.RuleSchedule.TimeOfDay)] = "02:00";

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule)));
            Assert.Equal(RuleSchedulePlugin.UnknownTimeZoneMessage, ex.Message);
        }

        [Fact]
        public void Engine_owned_columns_are_ignored_from_outside()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords);
            var ctx = Context(rule);

            var schedule = Schedule(ruleId: rule.Id);
            schedule[Q(SchemaNames.RuleSchedule.On)] = true;
            schedule[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Daily);
            schedule[Q(SchemaNames.RuleSchedule.TimeOfDay)] = "02:00";
            schedule[Q(SchemaNames.RuleSchedule.NextRunOn)] = new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            schedule[Q(SchemaNames.RuleSchedule.LastOutcome)] = new OptionSetValue((int)ScheduleOutcome.StartedRun);

            ctx.ExecuteTransactional<RuleSchedulePlugin>(CreateContext(schedule));

            var nextRun = schedule.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.NextRunOn));
            Assert.NotNull(nextRun);
            Assert.True(nextRun > DateTime.UtcNow);
            Assert.False(schedule.Contains(Q(SchemaNames.RuleSchedule.LastOutcome)));
        }

        [Fact]
        public void Engine_owned_columns_are_kept_inside_the_scheduler_api()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnCreate }); // deliberately not runnable
            var stored = Schedule(ruleId: rule.Id);
            var ctx = Context(rule, stored);

            var api = new XrmFakedPluginExecutionContext
            {
                MessageName = SchemaNames.Qualify(SchemaNames.StartDueSchedulesApi.MessageName),
                Stage = 30,
            };

            var patch = Schedule(id: stored.Id);
            patch[Q(SchemaNames.RuleSchedule.On)] = true; // would fail validation (no pattern) if checked
            patch[Q(SchemaNames.RuleSchedule.NextRunOn)] = new DateTime(2030, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            patch[Q(SchemaNames.RuleSchedule.LastRunOn)] = new DateTime(2030, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            patch[Q(SchemaNames.RuleSchedule.LastOutcome)] = new OptionSetValue((int)ScheduleOutcome.StartedRun);

            ctx.ExecuteTransactional<RuleSchedulePlugin>(UpdateContext(patch, api));

            Assert.Equal(new DateTime(2030, 1, 1, 0, 0, 0, DateTimeKind.Utc), patch.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.NextRunOn)));
            Assert.Equal(new DateTime(2030, 1, 1, 0, 0, 0, DateTimeKind.Utc), patch.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.LastRunOn)));
            Assert.Equal((int)ScheduleOutcome.StartedRun, patch.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleSchedule.LastOutcome)).Value);
        }

        [Fact]
        public void An_update_that_changes_the_pattern_recomputes_next_run()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords);
            var stored = Schedule(ruleId: rule.Id);
            stored[Q(SchemaNames.RuleSchedule.On)] = true;
            stored[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Daily);
            stored[Q(SchemaNames.RuleSchedule.TimeOfDay)] = "02:00";
            var ctx = Context(rule, stored);

            var patch = Schedule(id: stored.Id);
            patch[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.EveryMinutes);
            patch[Q(SchemaNames.RuleSchedule.Every)] = 15;

            ctx.ExecuteTransactional<RuleSchedulePlugin>(UpdateContext(patch));

            var nextRun = patch.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.NextRunOn));
            Assert.NotNull(nextRun);
            var expected = DateTime.UtcNow.AddMinutes(15);
            Assert.True(Math.Abs((nextRun.Value - expected).TotalMinutes) < 1);
        }

        [Fact]
        public void Turning_a_schedule_off_clears_next_run()
        {
            var rule = Rule("Test Rule", new[] { RuleTrigger.OnDemand }, OnDemandScope.AllRecords);
            var stored = Schedule(ruleId: rule.Id);
            stored[Q(SchemaNames.RuleSchedule.On)] = true;
            stored[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Daily);
            stored[Q(SchemaNames.RuleSchedule.TimeOfDay)] = "02:00";
            stored[Q(SchemaNames.RuleSchedule.NextRunOn)] = DateTime.UtcNow.AddDays(1);
            var ctx = Context(rule, stored);

            var patch = Schedule(id: stored.Id);
            patch[Q(SchemaNames.RuleSchedule.On)] = false;

            ctx.ExecuteTransactional<RuleSchedulePlugin>(UpdateContext(patch));

            Assert.True(patch.Contains(Q(SchemaNames.RuleSchedule.NextRunOn)));
            Assert.Null(patch.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.NextRunOn)));
        }
    }
}
