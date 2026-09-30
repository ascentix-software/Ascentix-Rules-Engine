using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Scheduling;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>What one asx_StartDueSchedules call produced: the runs to drive (runs this call
    /// started first, then runs it continued, then leftover runs, each once) and how many
    /// schedules were due (at most the cap).</summary>
    public sealed class DueScheduleResult
    {
        public List<Guid> RunIds { get; } = new List<Guid>();
        public int ScheduledCount { get; set; }
    }

    /// <summary>
    /// The scheduler's wake-up: records the heartbeat, then for each due Rule Schedule starts a
    /// run (or continues the rule's active one) and advances Next run on, and finally lists the
    /// other active runs of scheduled rules so the caller resumes them. All writes go through the
    /// system service from inside asx_StartDueSchedules, which is what lets RuleSchedulePlugin
    /// accept the engine-owned schedule columns; the runs it creates are owned by the caller.
    /// Once the call budget has elapsed it takes no further due schedules: they stay due for the
    /// next call.
    /// </summary>
    public sealed class DueScheduleProcessor
    {
        public const int DefaultMaxSchedules = 50;

        /// <summary>Wall-clock time after which a call stops starting or continuing schedules,
        /// well inside the platform's two-minute plug-in limit.</summary>
        public static readonly TimeSpan DefaultCallBudget = TimeSpan.FromSeconds(60);

        // RuleRunPlugin's refusal of a second active run for the same rule.
        private const string RunInProgressMessage = "already has a run in progress";

        private static string Q(string fragment) => SchemaNames.Qualify(fragment);

        private readonly IOrganizationService _system;
        private readonly Guid _callerId;
        private readonly ITracingService _trace;
        private readonly Func<DateTime> _utcNow;
        private readonly int _maxSchedules;
        private readonly Func<Entity, Guid> _createRun;
        private readonly TimeSpan _callBudget;
        private readonly RunDiagnostics _diagnostics;

        /// <param name="createRun">Creates the given asx_rulerun (an all-records run of a rule,
        /// owned by the caller) and returns its id. Defaults to a plain Create through
        /// <paramref name="system"/>, which RuleRunPlugin validates and queues; tests supply one
        /// that runs the plug-in themselves.</param>
        /// <param name="callBudget">Defaults to <see cref="DefaultCallBudget"/>; measured with
        /// <paramref name="utcNow"/>.</param>
        /// <param name="diagnostics">Receives the heartbeat / dueQuery / scheduleStart stages and
        /// the schedule counters; null ⇒ none.</param>
        public DueScheduleProcessor(IOrganizationService system, Guid callerId, ITracingService trace, Func<DateTime> utcNow,
            int maxSchedules = DefaultMaxSchedules, Func<Entity, Guid> createRun = null, TimeSpan? callBudget = null,
            RunDiagnostics diagnostics = null)
        {
            _system = system ?? throw new ArgumentNullException(nameof(system));
            _callerId = callerId;
            _trace = trace ?? throw new ArgumentNullException(nameof(trace));
            _utcNow = utcNow ?? throw new ArgumentNullException(nameof(utcNow));
            _maxSchedules = maxSchedules;
            _createRun = createRun ?? (run => _system.Create(run));
            _callBudget = callBudget ?? DefaultCallBudget;
            _diagnostics = diagnostics;
        }

        public DueScheduleResult Process()
        {
            var now = DateTime.SpecifyKind(_utcNow(), DateTimeKind.Utc);
            var result = new DueScheduleResult();
            var started = new List<Guid>();
            var continued = new List<Guid>();

            using (_diagnostics?.Time("heartbeat"))
                Heartbeat(now);

            List<Entity> due;
            using (_diagnostics?.Time("dueQuery"))
                due = DueSchedules(now);
            result.ScheduledCount = due.Count;
            foreach (var schedule in due)
            {
                // Out of time: the schedules not reached keep their Next run on and stay due.
                if (DateTime.SpecifyKind(_utcNow(), DateTimeKind.Utc) - now >= _callBudget)
                {
                    _trace.Trace($"asx_StartDueSchedules: the {_callBudget.TotalSeconds:0} s call budget is used; the remaining due schedules wait for the next call.");
                    break;
                }

                RunToDrive outcome;
                using (_diagnostics?.Time("scheduleStart"))
                    outcome = ProcessSchedule(schedule, now);
                if (outcome.RunId == null) continue;
                (outcome.Started ? started : continued).Add(outcome.RunId.Value);
            }

            // New runs first, so a long run that keeps being continued can't starve them; then
            // continued runs; then what earlier calls left running.
            List<Guid> leftover;
            using (_diagnostics?.Time("dueQuery"))
                leftover = LeftoverRuns().ToList();
            var seen = new HashSet<Guid>();
            foreach (var runId in started.Concat(continued).Concat(leftover))
                if (seen.Add(runId)) result.RunIds.Add(runId);

            if (_diagnostics != null)
            {
                _diagnostics.SchedulesStarted = started.Count;
                _diagnostics.SchedulesContinued = continued.Count;
                _diagnostics.SchedulesSkipped = due.Count - started.Count - continued.Count;
            }
            return result;
        }

        // What one schedule produced: the run to drive, if any, and whether this call started it.
        private struct RunToDrive
        {
            public Guid? RunId;
            public bool Started;

            public static readonly RunToDrive None = new RunToDrive();
            public static RunToDrive New(Guid runId) => new RunToDrive { RunId = runId, Started = true };
            public static RunToDrive Continued(Guid runId) => new RunToDrive { RunId = runId };
        }

        private void Heartbeat(DateTime now)
        {
            var query = new QueryExpression(Q(SchemaNames.SchedulerStatus.Entity))
            {
                ColumnSet = new ColumnSet(Q(SchemaNames.SchedulerStatus.LastSeenOn), Q(SchemaNames.SchedulerStatus.CallsToday)),
                TopCount = 1,
            };
            var status = _system.RetrieveMultiple(query).Entities.FirstOrDefault();
            var caller = new EntityReference("systemuser", _callerId);

            if (status == null)
            {
                _system.Create(new Entity(Q(SchemaNames.SchedulerStatus.Entity))
                {
                    [Q(SchemaNames.SchedulerStatus.Name)] = "Scheduler",
                    [Q(SchemaNames.SchedulerStatus.LastSeenOn)] = now,
                    [Q(SchemaNames.SchedulerStatus.LastSeenBy)] = caller,
                    [Q(SchemaNames.SchedulerStatus.CallsToday)] = 1,
                });
                return;
            }

            var lastSeen = status.GetAttributeValue<DateTime?>(Q(SchemaNames.SchedulerStatus.LastSeenOn));
            var sameDay = lastSeen != null && lastSeen.Value.ToUniversalTime().Date == now.Date;
            var calls = status.GetAttributeValue<int?>(Q(SchemaNames.SchedulerStatus.CallsToday)) ?? 0;
            _system.Update(new Entity(Q(SchemaNames.SchedulerStatus.Entity), status.Id)
            {
                [Q(SchemaNames.SchedulerStatus.LastSeenOn)] = now,
                [Q(SchemaNames.SchedulerStatus.LastSeenBy)] = caller,
                [Q(SchemaNames.SchedulerStatus.CallsToday)] = sameDay ? calls + 1 : 1,
            });
        }

        private List<Entity> DueSchedules(DateTime now)
        {
            var query = new QueryExpression(Q(SchemaNames.RuleSchedule.Entity))
            {
                ColumnSet = new ColumnSet(
                    Q(SchemaNames.RuleSchedule.Rule), Q(SchemaNames.RuleSchedule.Pattern), Q(SchemaNames.RuleSchedule.Every),
                    Q(SchemaNames.RuleSchedule.TimeOfDay), Q(SchemaNames.RuleSchedule.DaysOfWeek),
                    Q(SchemaNames.RuleSchedule.DayOfMonth), Q(SchemaNames.RuleSchedule.NextRunOn)),
                TopCount = _maxSchedules,
            };
            query.Criteria.AddCondition(Q(SchemaNames.RuleSchedule.On), ConditionOperator.Equal, true);
            query.Criteria.AddCondition(Q(SchemaNames.RuleSchedule.NextRunOn), ConditionOperator.LessEqual, now);
            query.AddOrder(Q(SchemaNames.RuleSchedule.NextRunOn), OrderType.Ascending);
            return _system.RetrieveMultiple(query).Entities.ToList();
        }

        // One due schedule: the run to drive (started or continued), or none.
        private RunToDrive ProcessSchedule(Entity schedule, DateTime now)
        {
            var ruleRef = schedule.GetAttributeValue<EntityReference>(Q(SchemaNames.RuleSchedule.Rule));
            if (ruleRef == null)
            {
                // Nothing to run, ever: switch it off so it stops coming due.
                _trace.Trace($"asx_StartDueSchedules: schedule {schedule.Id} has no rule; turned off.");
                TurnOff(schedule, now);
                return RunToDrive.None;
            }

            var rule = FindRule(ruleRef.Id);
            if (rule == null)
            {
                // The rule was deleted (its cascade removes the schedule): nothing to run or advance.
                _trace.Trace($"asx_StartDueSchedules: schedule {schedule.Id}'s rule is gone; skipped.");
                return RunToDrive.None;
            }

            var def = RuleScheduleDefinition.FromEntity(schedule);
            // An unknown time zone makes the rule unrunnable (its run would fail on dates), and
            // the schedule still moves forward, in UTC.
            var zoneKnown = EvaluationZone.TryResolve(EvaluationZone.SettingOf(rule), out var zone);
            if (!zoneKnown) zone = TimeZoneInfo.Utc;

            // Computed once, before anything is created: a corrupt recurrence (undefined pattern,
            // missing N, weekly with no days...) must not fail the call for every other schedule,
            // nor stay due forever. It is switched off instead. Every-N schedules keep their
            // rhythm: the next run is anchored on the one that just came due, not on the call time.
            DateTime next;
            try
            {
                next = ScheduleCalculator.NextRun(def, zone, now,
                    schedule.GetAttributeValue<DateTime?>(Q(SchemaNames.RuleSchedule.NextRunOn)));
            }
            catch (Exception e) when (e is ArgumentException || e is InvalidOperationException)
            {
                _trace.Trace($"asx_StartDueSchedules: schedule {schedule.Id} has no valid recurrence ({e.Message}); turned off.");
                TurnOff(schedule, now);
                return RunToDrive.None;
            }

            if (!zoneKnown || !IsRunnable(rule.Id))
            {
                MarkNotRunnable(schedule, next, now);
                return RunToDrive.None;
            }

            var active = FindActiveRun(rule.Id);
            if (active != null)
            {
                MarkContinued(schedule, active.Value, now);
                return RunToDrive.Continued(active.Value);
            }

            Guid runId;
            try
            {
                runId = _createRun(NewRun(rule.Id));
            }
            // Both catches are best-effort. On Dataverse a failed service call dooms the API's
            // transaction, so later writes in this call would fail anyway; the pre-checks above
            // (runnable, scope, active run) are what keep RuleRunPlugin from refusing the Create.
            catch (Exception e) when (e.Message != null && e.Message.Contains(RunInProgressMessage))
            {
                // A concurrent caller started the rule's run first: continue that one.
                active = FindActiveRun(rule.Id);
                if (active == null)
                {
                    _trace.Trace($"asx_StartDueSchedules: schedule {schedule.Id}'s concurrent run already finished; the next call starts one.");
                    return RunToDrive.None;
                }
                MarkContinued(schedule, active.Value, now);
                return RunToDrive.Continued(active.Value);
            }
            catch (Exception e)
            {
                _trace.Trace($"asx_StartDueSchedules: schedule {schedule.Id} could not start a run: {e.Message}");
                MarkNotRunnable(schedule, next, now);
                return RunToDrive.None;
            }

            _system.Update(new Entity(Q(SchemaNames.RuleSchedule.Entity), schedule.Id)
            {
                [Q(SchemaNames.RuleSchedule.LastOutcome)] = new OptionSetValue((int)ScheduleOutcome.StartedRun),
                [Q(SchemaNames.RuleSchedule.LastRun)] = new EntityReference(Q(SchemaNames.RuleRun.Entity), runId),
                [Q(SchemaNames.RuleSchedule.LastRunOn)] = now,
                [Q(SchemaNames.RuleSchedule.NextRunOn)] = next,
            });
            return RunToDrive.New(runId);
        }

        // A query rather than Retrieve: a missing rule is an empty result, not a service fault
        // (which would abort the call's transaction on Dataverse).
        private Entity FindRule(Guid ruleId)
        {
            var query = new QueryExpression(Q(SchemaNames.Rule.Entity))
            {
                ColumnSet = new ColumnSet(Q(SchemaNames.Rule.EvaluationTimeZone)),
                TopCount = 1,
            };
            query.Criteria.AddCondition(SchemaNames.PrimaryId(SchemaNames.DefaultPrefix, SchemaNames.Rule.Entity), ConditionOperator.Equal, ruleId);
            return _system.RetrieveMultiple(query).Entities.FirstOrDefault();
        }

        private bool IsRunnable(Guid ruleId)
        {
            try
            {
                return OnDemandRules.Resolve(_system, ruleId, _trace).Scope == OnDemandScope.AllRecords;
            }
            // Any failure, not only InvalidPluginExecutionException: resolving parses the published
            // revision, which can throw other types.
            catch (Exception e)
            {
                _trace.Trace($"asx_StartDueSchedules: rule {ruleId} is not runnable: {e.Message}");
                return false;
            }
        }

        private Guid? FindActiveRun(Guid ruleId)
        {
            var query = new QueryExpression(Q(SchemaNames.RuleRun.Entity)) { ColumnSet = new ColumnSet(false), TopCount = 1 };
            query.Criteria.AddCondition(Q(SchemaNames.RuleRun.Rule), ConditionOperator.Equal, ruleId);
            query.Criteria.AddCondition(Q(SchemaNames.RuleRun.Status), ConditionOperator.In, (int)RuleRunStatus.Queued, (int)RuleRunStatus.Running);
            return _system.RetrieveMultiple(query).Entities.FirstOrDefault()?.Id;
        }

        private void MarkNotRunnable(Entity schedule, DateTime next, DateTime now) =>
            _system.Update(new Entity(Q(SchemaNames.RuleSchedule.Entity), schedule.Id)
            {
                [Q(SchemaNames.RuleSchedule.LastOutcome)] = new OptionSetValue((int)ScheduleOutcome.RuleNotRunnable),
                [Q(SchemaNames.RuleSchedule.LastRunOn)] = now,
                [Q(SchemaNames.RuleSchedule.NextRunOn)] = next,
            });

        // A schedule that can never run: not runnable, switched off, and out of the due set.
        private void TurnOff(Entity schedule, DateTime now) =>
            _system.Update(new Entity(Q(SchemaNames.RuleSchedule.Entity), schedule.Id)
            {
                [Q(SchemaNames.RuleSchedule.LastOutcome)] = new OptionSetValue((int)ScheduleOutcome.RuleNotRunnable),
                [Q(SchemaNames.RuleSchedule.LastRunOn)] = now,
                [Q(SchemaNames.RuleSchedule.On)] = false,
                [Q(SchemaNames.RuleSchedule.NextRunOn)] = null,
            });

        // Next run on is left as is: the schedule stays due and continues until the run finishes.
        private void MarkContinued(Entity schedule, Guid runId, DateTime now) =>
            _system.Update(new Entity(Q(SchemaNames.RuleSchedule.Entity), schedule.Id)
            {
                [Q(SchemaNames.RuleSchedule.LastOutcome)] = new OptionSetValue((int)ScheduleOutcome.ContinuedRun),
                [Q(SchemaNames.RuleSchedule.LastRun)] = new EntityReference(Q(SchemaNames.RuleRun.Entity), runId),
                [Q(SchemaNames.RuleSchedule.LastRunOn)] = now,
            });

        // Queued or Running runs of rules with an On schedule: runs a previous wake-up stopped
        // driving partway.
        private IEnumerable<Guid> LeftoverRuns()
        {
            var query = new QueryExpression(Q(SchemaNames.RuleRun.Entity)) { ColumnSet = new ColumnSet(false) };
            query.Criteria.AddCondition(Q(SchemaNames.RuleRun.Status), ConditionOperator.In, (int)RuleRunStatus.Queued, (int)RuleRunStatus.Running);
            var schedule = query.AddLink(Q(SchemaNames.RuleSchedule.Entity), Q(SchemaNames.RuleRun.Rule), Q(SchemaNames.RuleSchedule.Rule));
            schedule.LinkCriteria.AddCondition(Q(SchemaNames.RuleSchedule.On), ConditionOperator.Equal, true);
            return _system.RetrieveMultiple(query).Entities.Select(run => run.Id);
        }

        // The run is created through the system service, so without an explicit owner it would
        // belong to SYSTEM: it is the caller's (the scheduler account's) run, like a run a user
        // starts by hand.
        private Entity NewRun(Guid ruleId) =>
            new Entity(Q(SchemaNames.RuleRun.Entity))
            {
                [Q(SchemaNames.RuleRun.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                ["ownerid"] = new EntityReference("systemuser", _callerId),
            };
    }
}
