using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Scheduling;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>What one asx_StartDueSchedules call produced: the runs to drive, in the order
    /// they were added, and how many schedules were due (at most the cap).</summary>
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
    /// accept the engine-owned schedule columns.
    /// </summary>
    public sealed class DueScheduleProcessor
    {
        public const int DefaultMaxSchedules = 50;

        // RuleRunPlugin's refusal of a second active run for the same rule.
        private const string RunInProgressMessage = "already has a run in progress";

        private static string Q(string fragment) => SchemaNames.Qualify(fragment);

        private readonly IOrganizationService _system;
        private readonly Guid _callerId;
        private readonly ITracingService _trace;
        private readonly Func<DateTime> _utcNow;
        private readonly int _maxSchedules;
        private readonly Func<Guid, Guid> _createRun;

        /// <param name="createRun">Creates an all-records asx_rulerun for a rule id and returns its
        /// id. Defaults to a plain Create through <paramref name="system"/>, which RuleRunPlugin
        /// validates and queues; tests supply one that runs the plug-in themselves.</param>
        public DueScheduleProcessor(IOrganizationService system, Guid callerId, ITracingService trace, Func<DateTime> utcNow,
            int maxSchedules = DefaultMaxSchedules, Func<Guid, Guid> createRun = null)
        {
            _system = system ?? throw new ArgumentNullException(nameof(system));
            _callerId = callerId;
            _trace = trace ?? throw new ArgumentNullException(nameof(trace));
            _utcNow = utcNow ?? throw new ArgumentNullException(nameof(utcNow));
            _maxSchedules = maxSchedules;
            _createRun = createRun ?? CreateRun;
        }

        public DueScheduleResult Process()
        {
            var now = DateTime.SpecifyKind(_utcNow(), DateTimeKind.Utc);
            var result = new DueScheduleResult();
            var seen = new HashSet<Guid>();
            void Add(Guid runId)
            {
                if (seen.Add(runId)) result.RunIds.Add(runId);
            }

            Heartbeat(now);

            var due = DueSchedules(now);
            result.ScheduledCount = due.Count;
            foreach (var schedule in due)
            {
                var runId = ProcessSchedule(schedule, now);
                if (runId != null) Add(runId.Value);
            }

            foreach (var runId in LeftoverRuns()) Add(runId);
            return result;
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

        // One due schedule. Returns the run to drive (started or continued), or null.
        private Guid? ProcessSchedule(Entity schedule, DateTime now)
        {
            var ruleRef = schedule.GetAttributeValue<EntityReference>(Q(SchemaNames.RuleSchedule.Rule));
            var rule = ruleRef != null ? FindRule(ruleRef.Id) : null;
            if (rule == null)
            {
                // The rule was deleted (its cascade removes the schedule): nothing to run or advance.
                _trace.Trace($"asx_StartDueSchedules: schedule {schedule.Id} has no rule; skipped.");
                return null;
            }

            var def = RuleScheduleDefinition.FromEntity(schedule);
            // An unknown time zone makes the rule unrunnable (its run would fail on dates), and
            // the schedule still moves forward, in UTC.
            var zoneKnown = EvaluationZone.TryResolve(EvaluationZone.SettingOf(rule), out var zone);
            if (!zoneKnown) zone = TimeZoneInfo.Utc;

            if (!zoneKnown || !IsRunnable(rule.Id))
            {
                MarkNotRunnable(schedule, def, zone, now);
                return null;
            }

            var active = FindActiveRun(rule.Id);
            if (active != null)
            {
                MarkContinued(schedule, active.Value, now);
                return active;
            }

            Guid runId;
            try
            {
                runId = _createRun(rule.Id);
            }
            catch (Exception e) when (e.Message != null && e.Message.Contains(RunInProgressMessage))
            {
                // A concurrent caller started the rule's run first: continue that one.
                active = FindActiveRun(rule.Id);
                if (active == null)
                {
                    _trace.Trace($"asx_StartDueSchedules: schedule {schedule.Id}'s concurrent run already finished; the next call starts one.");
                    return null;
                }
                MarkContinued(schedule, active.Value, now);
                return active;
            }
            catch (Exception e)
            {
                _trace.Trace($"asx_StartDueSchedules: schedule {schedule.Id} could not start a run: {e.Message}");
                MarkNotRunnable(schedule, def, zone, now);
                return null;
            }

            _system.Update(new Entity(Q(SchemaNames.RuleSchedule.Entity), schedule.Id)
            {
                [Q(SchemaNames.RuleSchedule.LastOutcome)] = new OptionSetValue((int)ScheduleOutcome.StartedRun),
                [Q(SchemaNames.RuleSchedule.LastRun)] = new EntityReference(Q(SchemaNames.RuleRun.Entity), runId),
                [Q(SchemaNames.RuleSchedule.LastRunOn)] = now,
                [Q(SchemaNames.RuleSchedule.NextRunOn)] = ScheduleCalculator.NextRun(def, zone, now),
            });
            return runId;
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
            catch (InvalidPluginExecutionException e)
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

        private void MarkNotRunnable(Entity schedule, RuleScheduleDefinition def, TimeZoneInfo zone, DateTime now) =>
            _system.Update(new Entity(Q(SchemaNames.RuleSchedule.Entity), schedule.Id)
            {
                [Q(SchemaNames.RuleSchedule.LastOutcome)] = new OptionSetValue((int)ScheduleOutcome.RuleNotRunnable),
                [Q(SchemaNames.RuleSchedule.LastRunOn)] = now,
                [Q(SchemaNames.RuleSchedule.NextRunOn)] = ScheduleCalculator.NextRun(def, zone, now),
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

        private Guid CreateRun(Guid ruleId) =>
            _system.Create(new Entity(Q(SchemaNames.RuleRun.Entity))
            {
                [Q(SchemaNames.RuleRun.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
            });
    }
}
