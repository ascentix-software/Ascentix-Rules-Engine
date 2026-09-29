using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Scheduling;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// asx_StartDueSchedules: heartbeat, due schedules (at most the cap), start or continue a
    /// run per schedule, advance Next run on, resume leftover runs of scheduled rules. Runs are
    /// created through <see cref="RuleRunPlugin"/> (executed on the Target before the faked
    /// Create), since FakeXrmEasy's pipeline simulation isn't enabled in this project.
    /// </summary>
    public class DueScheduleProcessorTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private static readonly DateTime Now = new DateTime(2026, 9, 29, 12, 0, 0, DateTimeKind.Utc);
        private static readonly Guid Caller = Guid.NewGuid();

        private readonly XrmFakedContext _ctx = new XrmFakedContext();
        private IOrganizationService Service => _ctx.GetOrganizationService();

        // A published On demand, all-records account rule (legacy: no publishedrevision), loaded
        // live by RuleBuckets like RuleRunPluginTests.
        private static Entity Rule(string name, OnDemandScope scope = OnDemandScope.AllRecords,
            RuleTrigger trigger = RuleTrigger.OnDemand, string timeZone = null)
        {
            var rule = new Entity(Q(SchemaNames.Rule.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.PrimaryName)] = name,
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)trigger) }),
                [Q(SchemaNames.Rule.OnDemandScope)] = new OptionSetValue((int)scope),
            };
            if (timeZone != null) rule[Q(SchemaNames.Rule.EvaluationTimeZone)] = timeZone;
            return rule;
        }

        // Every hour, on, due at nextRunOn.
        private static Entity Schedule(Guid? ruleId, DateTime nextRunOn, bool on = true)
        {
            var schedule = new Entity(Q(SchemaNames.RuleSchedule.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleSchedule.Name)] = "Schedule",
                [Q(SchemaNames.RuleSchedule.On)] = on,
                [Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.EveryHours),
                [Q(SchemaNames.RuleSchedule.Every)] = 1,
                [Q(SchemaNames.RuleSchedule.NextRunOn)] = nextRunOn,
            };
            if (ruleId != null) schedule[Q(SchemaNames.RuleSchedule.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId.Value);
            return schedule;
        }

        private static Entity ActiveRun(Guid ruleId, RuleRunStatus status = RuleRunStatus.Running) =>
            new Entity(Q(SchemaNames.RuleRun.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleRun.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                [Q(SchemaNames.RuleRun.Status)] = new OptionSetValue((int)status),
            };

        // The platform's Create of asx_rulerun: RuleRunPlugin (pre-operation) validates and queues
        // the Target, then the row is stored.
        private Guid CreateThroughPlugin(Guid ruleId)
        {
            var run = new Entity(Q(SchemaNames.RuleRun.Entity))
            {
                [Q(SchemaNames.RuleRun.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
            };
            _ctx.ExecutePluginWith<RuleRunPlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "Create",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.RuleRun.Entity),
                InputParameters = new ParameterCollection { { "Target", run } },
            });
            return Service.Create(run);
        }

        private DueScheduleResult Process(int maxSchedules = 50, Func<Guid, Guid> createRun = null) =>
            new DueScheduleProcessor(Service, Caller, new XrmFakedTracingService(), () => Now, maxSchedules, createRun ?? CreateThroughPlugin).Process();

        private Entity Reload(Entity entity) => Service.Retrieve(entity.LogicalName, entity.Id, new ColumnSet(true));

        private List<Entity> Runs(Guid ruleId)
        {
            var query = new QueryExpression(Q(SchemaNames.RuleRun.Entity)) { ColumnSet = new ColumnSet(true) };
            query.Criteria.AddCondition(Q(SchemaNames.RuleRun.Rule), ConditionOperator.Equal, ruleId);
            return Service.RetrieveMultiple(query).Entities.ToList();
        }

        private List<Entity> StatusRows()
        {
            var query = new QueryExpression(Q(SchemaNames.SchedulerStatus.Entity)) { ColumnSet = new ColumnSet(true) };
            return Service.RetrieveMultiple(query).Entities.ToList();
        }

        private static int? Outcome(Entity schedule) =>
            schedule.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleSchedule.LastOutcome))?.Value;

        private static DateTime? NextRunOn(Entity schedule) =>
            schedule.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.NextRunOn));

        [Fact]
        public void First_call_creates_the_heartbeat_row()
        {
            var rule = Rule("All");
            _ctx.Initialize(new List<Entity> { rule, Schedule(rule.Id, Now.AddHours(1)) });

            Process();

            var status = Assert.Single(StatusRows());
            Assert.Equal("Scheduler", status.GetAttributeValue<string>(Q(SchemaNames.SchedulerStatus.Name)));
            Assert.Equal(Now, status.GetAttributeValue<DateTime>(Q(SchemaNames.SchedulerStatus.LastSeenOn)).ToUniversalTime());
            Assert.Equal(Caller, status.GetAttributeValue<EntityReference>(Q(SchemaNames.SchedulerStatus.LastSeenBy)).Id);
            Assert.Equal(1, status.GetAttributeValue<int>(Q(SchemaNames.SchedulerStatus.CallsToday)));
        }

        [Fact]
        public void Calls_today_resets_on_a_new_utc_date()
        {
            var status = new Entity(Q(SchemaNames.SchedulerStatus.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.SchedulerStatus.Name)] = "Scheduler",
                [Q(SchemaNames.SchedulerStatus.LastSeenOn)] = Now.Date.AddMinutes(-1), // 23:59 yesterday, UTC
                [Q(SchemaNames.SchedulerStatus.LastSeenBy)] = new EntityReference("systemuser", Guid.NewGuid()),
                [Q(SchemaNames.SchedulerStatus.CallsToday)] = 7,
            };
            _ctx.Initialize(new List<Entity> { status });

            Process();

            var stored = Assert.Single(StatusRows());
            Assert.Equal(status.Id, stored.Id);
            Assert.Equal(1, stored.GetAttributeValue<int>(Q(SchemaNames.SchedulerStatus.CallsToday)));
            Assert.Equal(Now, stored.GetAttributeValue<DateTime>(Q(SchemaNames.SchedulerStatus.LastSeenOn)).ToUniversalTime());
            Assert.Equal(Caller, stored.GetAttributeValue<EntityReference>(Q(SchemaNames.SchedulerStatus.LastSeenBy)).Id);
        }

        [Fact]
        public void Calls_today_increments_on_the_same_utc_date()
        {
            var status = new Entity(Q(SchemaNames.SchedulerStatus.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.SchedulerStatus.Name)] = "Scheduler",
                [Q(SchemaNames.SchedulerStatus.LastSeenOn)] = Now.Date.AddMinutes(1),
                [Q(SchemaNames.SchedulerStatus.CallsToday)] = 7,
            };
            _ctx.Initialize(new List<Entity> { status });

            Process();

            var stored = Assert.Single(StatusRows());
            Assert.Equal(8, stored.GetAttributeValue<int>(Q(SchemaNames.SchedulerStatus.CallsToday)));
        }

        [Fact]
        public void A_due_schedule_starts_a_run_and_advances()
        {
            var rule = Rule("All");
            var schedule = Schedule(rule.Id, Now.AddMinutes(-1));
            _ctx.Initialize(new List<Entity> { rule, schedule });

            var result = Process();

            var run = Assert.Single(Runs(rule.Id));
            Assert.Equal((int)RuleRunStatus.Queued, run.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleRun.Status)).Value);
            var stored = Reload(schedule);
            Assert.Equal((int)ScheduleOutcome.StartedRun, Outcome(stored));
            Assert.Equal(run.Id, stored.GetAttributeValue<EntityReference>(Q(SchemaNames.RuleSchedule.LastRun)).Id);
            Assert.Equal(Now, stored.GetAttributeValue<DateTime>(Q(SchemaNames.RuleSchedule.LastRunOn)).ToUniversalTime());
            Assert.Equal(Now.AddHours(1), NextRunOn(stored).Value.ToUniversalTime());
            Assert.True(NextRunOn(stored).Value.ToUniversalTime() > Now);
            Assert.Equal(new[] { run.Id }, result.RunIds.ToArray());
            Assert.Equal(1, result.ScheduledCount);
        }

        [Fact]
        public void A_schedule_not_yet_due_is_left_alone()
        {
            var rule = Rule("All");
            var schedule = Schedule(rule.Id, Now.AddMinutes(1));
            var off = Schedule(Rule("Off").Id, Now.AddMinutes(-1), on: false);
            _ctx.Initialize(new List<Entity> { rule, schedule, off });

            var result = Process();

            Assert.Empty(Runs(rule.Id));
            var stored = Reload(schedule);
            Assert.Null(Outcome(stored));
            Assert.Equal(Now.AddMinutes(1), NextRunOn(stored).Value.ToUniversalTime());
            Assert.Null(Outcome(Reload(off)));
            Assert.Empty(result.RunIds);
            Assert.Equal(0, result.ScheduledCount);
        }

        [Fact]
        public void An_active_run_is_continued_not_duplicated()
        {
            var rule = Rule("All");
            var schedule = Schedule(rule.Id, Now.AddMinutes(-1));
            var active = ActiveRun(rule.Id);
            _ctx.Initialize(new List<Entity> { rule, schedule, active });

            var result = Process();

            Assert.Equal(active.Id, Assert.Single(Runs(rule.Id)).Id);
            var stored = Reload(schedule);
            Assert.Equal((int)ScheduleOutcome.ContinuedRun, Outcome(stored));
            Assert.Equal(active.Id, stored.GetAttributeValue<EntityReference>(Q(SchemaNames.RuleSchedule.LastRun)).Id);
            Assert.Equal(Now, stored.GetAttributeValue<DateTime>(Q(SchemaNames.RuleSchedule.LastRunOn)).ToUniversalTime());
            Assert.Equal(Now.AddMinutes(-1), NextRunOn(stored).Value.ToUniversalTime());
            Assert.Contains(active.Id, result.RunIds);
        }

        [Fact]
        public void A_queued_run_is_continued_too()
        {
            var rule = Rule("All");
            var schedule = Schedule(rule.Id, Now.AddMinutes(-1));
            var queued = ActiveRun(rule.Id, RuleRunStatus.Queued);
            var finished = ActiveRun(rule.Id, RuleRunStatus.Completed);
            _ctx.Initialize(new List<Entity> { rule, schedule, queued, finished });

            var result = Process();

            Assert.Equal(2, Runs(rule.Id).Count);
            Assert.Equal((int)ScheduleOutcome.ContinuedRun, Outcome(Reload(schedule)));
            Assert.Equal(new[] { queued.Id }, result.RunIds.ToArray());
        }

        [Fact]
        public void A_rule_that_is_not_runnable_is_skipped_and_advanced()
        {
            var onSave = Rule("Save", trigger: RuleTrigger.OnCreate);
            var given = Rule("Given", scope: OnDemandScope.GivenRecord);
            var onSaveSchedule = Schedule(onSave.Id, Now.AddMinutes(-1));
            var givenSchedule = Schedule(given.Id, Now.AddMinutes(-2));
            _ctx.Initialize(new List<Entity> { onSave, given, onSaveSchedule, givenSchedule });

            var result = Process();

            foreach (var schedule in new[] { onSaveSchedule, givenSchedule })
            {
                var stored = Reload(schedule);
                Assert.Equal((int)ScheduleOutcome.RuleNotRunnable, Outcome(stored));
                Assert.Equal(Now, stored.GetAttributeValue<DateTime>(Q(SchemaNames.RuleSchedule.LastRunOn)).ToUniversalTime());
                Assert.Equal(Now.AddHours(1), NextRunOn(stored).Value.ToUniversalTime());
                Assert.Null(stored.GetAttributeValue<EntityReference>(Q(SchemaNames.RuleSchedule.LastRun)));
            }
            Assert.Empty(Runs(onSave.Id));
            Assert.Empty(Runs(given.Id));
            Assert.Empty(result.RunIds);
            Assert.Equal(2, result.ScheduledCount);
        }

        [Fact]
        public void An_unknown_time_zone_advances_in_utc_without_failing_the_call()
        {
            var lost = Rule("Lost zone", timeZone: "Not/A Zone");
            var fine = Rule("Fine");
            var lostSchedule = Schedule(lost.Id, Now.AddMinutes(-2));
            lostSchedule[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Daily);
            lostSchedule[Q(SchemaNames.RuleSchedule.TimeOfDay)] = "09:00";
            lostSchedule[Q(SchemaNames.RuleSchedule.Every)] = null;
            var fineSchedule = Schedule(fine.Id, Now.AddMinutes(-1));
            _ctx.Initialize(new List<Entity> { lost, fine, lostSchedule, fineSchedule });

            var result = Process();

            var stored = Reload(lostSchedule);
            Assert.Equal((int)ScheduleOutcome.RuleNotRunnable, Outcome(stored));
            Assert.Equal(new DateTime(2026, 9, 30, 9, 0, 0, DateTimeKind.Utc), NextRunOn(stored).Value.ToUniversalTime());
            Assert.Empty(Runs(lost.Id));
            Assert.Equal((int)ScheduleOutcome.StartedRun, Outcome(Reload(fineSchedule)));
            Assert.Single(result.RunIds);
        }

        [Fact]
        public void A_concurrent_create_refusal_is_treated_as_continue()
        {
            var rule = Rule("All");
            var schedule = Schedule(rule.Id, Now.AddMinutes(-1));
            _ctx.Initialize(new List<Entity> { rule, schedule });

            // Another caller creates the rule's run between our active-run check and our Create:
            // RuleRunPlugin then refuses ours with "This rule already has a run in progress…".
            Guid concurrent = Guid.Empty;
            Func<Guid, Guid> racingCreate = ruleId =>
            {
                concurrent = Service.Create(ActiveRun(ruleId, RuleRunStatus.Queued));
                return CreateThroughPlugin(ruleId);
            };

            var result = Process(createRun: racingCreate);

            Assert.Equal(concurrent, Assert.Single(Runs(rule.Id)).Id);
            var stored = Reload(schedule);
            Assert.Equal((int)ScheduleOutcome.ContinuedRun, Outcome(stored));
            Assert.Equal(concurrent, stored.GetAttributeValue<EntityReference>(Q(SchemaNames.RuleSchedule.LastRun)).Id);
            Assert.Equal(Now.AddMinutes(-1), NextRunOn(stored).Value.ToUniversalTime());
            Assert.Equal(new[] { concurrent }, result.RunIds.ToArray());
        }

        [Fact]
        public void Any_other_create_failure_marks_the_rule_not_runnable_and_advances()
        {
            var rule = Rule("All");
            var schedule = Schedule(rule.Id, Now.AddMinutes(-1));
            _ctx.Initialize(new List<Entity> { rule, schedule });

            var result = Process(createRun: _ => throw new InvalidPluginExecutionException("Something else went wrong."));

            var stored = Reload(schedule);
            Assert.Equal((int)ScheduleOutcome.RuleNotRunnable, Outcome(stored));
            Assert.Equal(Now.AddHours(1), NextRunOn(stored).Value.ToUniversalTime());
            Assert.Empty(result.RunIds);
        }

        [Fact]
        public void A_schedule_whose_rule_disappeared_is_skipped()
        {
            var fine = Rule("Fine");
            var vanished = Schedule(Guid.NewGuid(), Now.AddMinutes(-3)); // rule deleted mid-call
            var fineSchedule = Schedule(fine.Id, Now.AddMinutes(-1));
            _ctx.Initialize(new List<Entity> { fine, vanished, fineSchedule });

            var result = Process();

            var stored = Reload(vanished);
            Assert.Null(Outcome(stored));
            Assert.True(stored.GetAttributeValue<bool>(Q(SchemaNames.RuleSchedule.On)));
            Assert.Equal(Now.AddMinutes(-3), NextRunOn(stored).Value.ToUniversalTime());
            Assert.Equal((int)ScheduleOutcome.StartedRun, Outcome(Reload(fineSchedule)));
            Assert.Single(result.RunIds);
            Assert.Equal(2, result.ScheduledCount);
        }

        private void AssertTurnedOff(Entity schedule)
        {
            var stored = Reload(schedule);
            Assert.Equal((int)ScheduleOutcome.RuleNotRunnable, Outcome(stored));
            Assert.Equal(Now, stored.GetAttributeValue<DateTime>(Q(SchemaNames.RuleSchedule.LastRunOn)).ToUniversalTime());
            Assert.False(stored.GetAttributeValue<bool>(Q(SchemaNames.RuleSchedule.On)));
            Assert.Null(NextRunOn(stored));
        }

        [Fact]
        public void A_due_schedule_without_a_rule_is_turned_off()
        {
            var fine = Rule("Fine");
            var noRule = Schedule(null, Now.AddMinutes(-2));
            var fineSchedule = Schedule(fine.Id, Now.AddMinutes(-1));
            _ctx.Initialize(new List<Entity> { fine, noRule, fineSchedule });

            var result = Process();

            AssertTurnedOff(noRule);
            Assert.Equal((int)ScheduleOutcome.StartedRun, Outcome(Reload(fineSchedule)));
            Assert.Single(result.RunIds);
        }

        [Fact]
        public void A_corrupt_recurrence_is_turned_off_without_stopping_the_others()
        {
            var weekly = Rule("Weekly");
            var undefined = Rule("Undefined");
            var missingN = Rule("Missing N");
            var fine = Rule("Fine");
            var noDays = Schedule(weekly.Id, Now.AddMinutes(-4));
            noDays[Q(SchemaNames.RuleSchedule.Pattern)] = new OptionSetValue((int)SchedulePattern.Weekly);
            noDays[Q(SchemaNames.RuleSchedule.TimeOfDay)] = "09:00";
            var noPattern = Schedule(undefined.Id, Now.AddMinutes(-3));
            noPattern.Attributes.Remove(Q(SchemaNames.RuleSchedule.Pattern));
            var noEvery = Schedule(missingN.Id, Now.AddMinutes(-2));
            noEvery.Attributes.Remove(Q(SchemaNames.RuleSchedule.Every));
            var fineSchedule = Schedule(fine.Id, Now.AddMinutes(-1));
            _ctx.Initialize(new List<Entity> { weekly, undefined, missingN, fine, noDays, noPattern, noEvery, fineSchedule });

            var result = Process();

            AssertTurnedOff(noDays);
            AssertTurnedOff(noPattern);
            AssertTurnedOff(noEvery);
            Assert.Empty(Runs(weekly.Id));
            Assert.Empty(Runs(undefined.Id));
            Assert.Empty(Runs(missingN.Id));
            var run = Assert.Single(Runs(fine.Id));
            Assert.Equal((int)ScheduleOutcome.StartedRun, Outcome(Reload(fineSchedule)));
            Assert.Equal(new[] { run.Id }, result.RunIds.ToArray());
            Assert.Equal(4, result.ScheduledCount);
        }

        [Fact]
        public void A_rule_whose_resolution_fails_unexpectedly_is_marked_not_runnable()
        {
            // Its published revision is missing: loading it faults with a service error, not an
            // InvalidPluginExecutionException.
            var broken = Rule("Broken");
            broken[Q(SchemaNames.Rule.PublishedRevision)] = new EntityReference(Q(SchemaNames.RuleRevision.Entity), Guid.NewGuid());
            var fine = Rule("Fine");
            var brokenSchedule = Schedule(broken.Id, Now.AddMinutes(-2));
            var fineSchedule = Schedule(fine.Id, Now.AddMinutes(-1));
            _ctx.Initialize(new List<Entity> { broken, fine, brokenSchedule, fineSchedule });

            var result = Process();

            var stored = Reload(brokenSchedule);
            Assert.Equal((int)ScheduleOutcome.RuleNotRunnable, Outcome(stored));
            Assert.Equal(Now.AddHours(1), NextRunOn(stored).Value.ToUniversalTime());
            Assert.Empty(Runs(broken.Id));
            Assert.Equal((int)ScheduleOutcome.StartedRun, Outcome(Reload(fineSchedule)));
            Assert.Single(result.RunIds);
        }

        [Fact]
        public void At_most_the_cap_is_processed_per_call()
        {
            var a = Rule("A");
            var b = Rule("B");
            var c = Rule("C");
            var first = Schedule(a.Id, Now.AddMinutes(-30));
            var second = Schedule(b.Id, Now.AddMinutes(-20));
            var third = Schedule(c.Id, Now.AddMinutes(-10));
            _ctx.Initialize(new List<Entity> { a, b, c, third, first, second });

            var result = Process(maxSchedules: 2);

            Assert.Equal(2, result.ScheduledCount);
            Assert.Equal(2, result.RunIds.Count);
            Assert.Equal((int)ScheduleOutcome.StartedRun, Outcome(Reload(first)));
            Assert.Equal((int)ScheduleOutcome.StartedRun, Outcome(Reload(second)));
            var waiting = Reload(third);
            Assert.Null(Outcome(waiting));
            Assert.Equal(Now.AddMinutes(-10), NextRunOn(waiting).Value.ToUniversalTime());
            Assert.Empty(Runs(c.Id));
        }

        [Fact]
        public void Leftover_active_runs_of_scheduled_rules_are_returned()
        {
            var scheduled = Rule("Scheduled");
            var unscheduled = Rule("Unscheduled");
            var switchedOff = Rule("Switched off");
            var leftover = ActiveRun(scheduled.Id);
            var manual = ActiveRun(unscheduled.Id);
            var offRun = ActiveRun(switchedOff.Id, RuleRunStatus.Queued);
            var finished = ActiveRun(scheduled.Id, RuleRunStatus.Completed);
            _ctx.Initialize(new List<Entity>
            {
                scheduled, unscheduled, switchedOff,
                Schedule(scheduled.Id, Now.AddHours(1)),
                Schedule(switchedOff.Id, Now.AddHours(1), on: false),
                leftover, manual, offRun, finished,
            });

            var result = Process();

            Assert.Equal(new[] { leftover.Id }, result.RunIds.ToArray());
            Assert.Equal(0, result.ScheduledCount);
        }

        [Fact]
        public void Run_ids_are_unique()
        {
            var rule = Rule("All");
            var started = Rule("Started");
            var active = ActiveRun(rule.Id);
            _ctx.Initialize(new List<Entity>
            {
                rule, started, active,
                Schedule(rule.Id, Now.AddMinutes(-1)),
                Schedule(started.Id, Now.AddMinutes(-2)),
            });

            var result = Process();

            // The continued run and the new run are also leftover active runs of scheduled rules:
            // each appears once, in the order it was added.
            var newRun = Assert.Single(Runs(started.Id)).Id;
            Assert.Equal(new[] { newRun, active.Id }, result.RunIds.ToArray());
        }

        [Fact]
        public void The_api_writes_run_ids_json_and_count()
        {
            var rule = Rule("All");
            // The API reads the real clock.
            _ctx.Initialize(new List<Entity> { rule, Schedule(rule.Id, DateTime.UtcNow.AddMinutes(-1)) });

            var pctx = new XrmFakedPluginExecutionContext
            {
                MessageName = Q(SchemaNames.StartDueSchedulesApi.MessageName),
                Stage = 30,
                InitiatingUserId = Caller,
                InputParameters = new ParameterCollection(),
                OutputParameters = new ParameterCollection(),
            };
            _ctx.ExecutePluginWith<StartDueSchedulesApi>(pctx);

            var runId = Assert.Single(Runs(rule.Id)).Id;
            var json = (string)pctx.OutputParameters[SchemaNames.StartDueSchedulesApi.PropRunIds];
            Assert.Equal(new[] { runId }, RunState.ParseRecordIds(json).ToArray());
            Assert.Equal(1, (int)pctx.OutputParameters[SchemaNames.StartDueSchedulesApi.PropScheduledCount]);
            Assert.Equal(Caller, Assert.Single(StatusRows()).GetAttributeValue<EntityReference>(Q(SchemaNames.SchedulerStatus.LastSeenBy)).Id);
        }
    }
}
