using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Scheduling;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Pre-operation, Create and Update of asx_ruleschedule. Validates the schedule (one per
    /// rule, valid recurrence, the rule or its open draft is an On demand/all-records rule, a
    /// recognized time zone) and computes asx_nextrunon. asx_nextrunon, asx_lastrunon, asx_lastrun
    /// and asx_lastoutcome are the scheduler's to keep: a caller with Write on the table can't set
    /// them directly, only asx_StartDueSchedules (and the run it starts) can.
    /// </summary>
    public sealed class RuleSchedulePlugin : PluginBase
    {
        public const string AlreadyScheduledMessage = "This rule already has a schedule.";
        public const string NotRunnableMessage = "Only On demand rules that run for all records can be scheduled.";
        public const string UnknownTimeZoneMessage = "The rule's time zone is not recognized.";

        private static string Q(string fragment) => SchemaNames.Qualify(fragment);

        // The scheduler's own columns: never the caller's to set from outside asx_StartDueSchedules.
        private static readonly string[] EngineOwnedColumns =
        {
            Q(SchemaNames.RuleSchedule.NextRunOn),
            Q(SchemaNames.RuleSchedule.LastRunOn),
            Q(SchemaNames.RuleSchedule.LastRun),
            Q(SchemaNames.RuleSchedule.LastOutcome),
        };

        // Columns whose change (Create, or presence in an Update's Target) requires recomputing
        // asx_nextrunon.
        private static readonly string[] RecomputeColumns =
        {
            Q(SchemaNames.RuleSchedule.On),
            Q(SchemaNames.RuleSchedule.Pattern),
            Q(SchemaNames.RuleSchedule.Every),
            Q(SchemaNames.RuleSchedule.TimeOfDay),
            Q(SchemaNames.RuleSchedule.DaysOfWeek),
            Q(SchemaNames.RuleSchedule.DayOfMonth),
            Q(SchemaNames.RuleSchedule.Rule),
        };

        public RuleSchedulePlugin() : base(typeof(RuleSchedulePlugin)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            var context = local.PluginExecutionContext;
            var system = local.SystemUserService;

            var target = context.InputParameters.TryGetValue("Target", out var input) ? input as Entity : null;
            if (target == null) return;

            // Inside the scheduler API's own writes (marking a run started, stamping the last
            // outcome), the engine-owned columns are exactly what it is there to set: skip the
            // rest of the checks entirely.
            if (PluginReentry.IsInsideMessage(context, Q(SchemaNames.StartDueSchedulesApi.MessageName))) return;

            foreach (var column in EngineOwnedColumns) target.Attributes.Remove(column);

            var isCreate = string.Equals(context.MessageName, "Create", StringComparison.OrdinalIgnoreCase);

            Entity stored = null;
            if (!isCreate)
                stored = system.Retrieve(Q(SchemaNames.RuleSchedule.Entity), target.Id, new ColumnSet(
                    Q(SchemaNames.RuleSchedule.Rule), Q(SchemaNames.RuleSchedule.On), Q(SchemaNames.RuleSchedule.Pattern),
                    Q(SchemaNames.RuleSchedule.Every), Q(SchemaNames.RuleSchedule.TimeOfDay),
                    Q(SchemaNames.RuleSchedule.DaysOfWeek), Q(SchemaNames.RuleSchedule.DayOfMonth)));

            var effective = Effective(target, stored);
            var ruleRef = effective.GetAttributeValue<EntityReference>(Q(SchemaNames.RuleSchedule.Rule));
            var ruleChanged = isCreate || target.Contains(Q(SchemaNames.RuleSchedule.Rule));

            // One per rule.
            if (ruleRef != null && ruleChanged)
            {
                var duplicate = new QueryExpression(Q(SchemaNames.RuleSchedule.Entity)) { ColumnSet = new ColumnSet(false), TopCount = 1 };
                duplicate.Criteria.AddCondition(Q(SchemaNames.RuleSchedule.Rule), ConditionOperator.Equal, ruleRef.Id);
                if (!isCreate)
                    duplicate.Criteria.AddCondition(SchemaNames.PrimaryId(SchemaNames.DefaultPrefix, SchemaNames.RuleSchedule.Entity),
                        ConditionOperator.NotEqual, target.Id);
                if (system.RetrieveMultiple(duplicate).Entities.Count > 0)
                    throw new InvalidPluginExecutionException(AlreadyScheduledMessage);
            }

            var on = effective.GetAttributeValue<bool>(Q(SchemaNames.RuleSchedule.On));
            var rule = ruleRef != null
                ? system.Retrieve(Q(SchemaNames.Rule.Entity), ruleRef.Id, new ColumnSet(
                    Q(SchemaNames.Rule.Triggers), Q(SchemaNames.Rule.OnDemandScope),
                    Q(SchemaNames.PrimaryName), Q(SchemaNames.Rule.EvaluationTimeZone)))
                : null;

            var def = RuleScheduleDefinition.FromEntity(effective);
            var zone = TimeZoneInfo.Utc;
            if (on)
            {
                var validationMessage = ScheduleCalculator.Validate(def);
                if (validationMessage != null) throw new InvalidPluginExecutionException(validationMessage);

                if (!IsRunnable(rule) && !IsRunnable(FindDraft(system, ruleRef?.Id)))
                    throw new InvalidPluginExecutionException(NotRunnableMessage);

                if (!EvaluationZone.TryResolve(EvaluationZone.SettingOf(rule), out zone))
                    throw new InvalidPluginExecutionException(UnknownTimeZoneMessage);
            }

            if (isCreate || RecomputeColumns.Any(target.Contains))
                target[Q(SchemaNames.RuleSchedule.NextRunOn)] = on ? ScheduleCalculator.NextRun(def, zone, DateTime.UtcNow) : (DateTime?)null;

            if (isCreate && string.IsNullOrWhiteSpace(target.GetAttributeValue<string>(Q(SchemaNames.RuleSchedule.Name))))
            {
                var ruleName = rule?.GetAttributeValue<string>(Q(SchemaNames.PrimaryName));
                target[Q(SchemaNames.RuleSchedule.Name)] = $"{ruleName} schedule";
            }
        }

        // The Target laid over the stored row: what ScheduleCalculator, the duplicate check and
        // the On flag see as the schedule's effective state.
        private static Entity Effective(Entity target, Entity stored)
        {
            var merged = new Entity(target.LogicalName, target.Id);
            if (stored != null) foreach (var attribute in stored.Attributes) merged[attribute.Key] = attribute.Value;
            foreach (var attribute in target.Attributes) merged[attribute.Key] = attribute.Value;
            return merged;
        }

        private static bool IsRunnable(Entity rule)
        {
            if (rule == null) return false;
            var triggers = rule.GetAttributeValue<OptionSetValueCollection>(Q(SchemaNames.Rule.Triggers));
            var scope = rule.GetAttributeValue<OptionSetValue>(Q(SchemaNames.Rule.OnDemandScope));
            return triggers != null && triggers.Any(trigger => trigger.Value == (int)RuleTrigger.OnDemand)
                && scope != null && scope.Value == (int)OnDemandScope.AllRecords;
        }

        private static Entity FindDraft(IOrganizationService system, Guid? ruleId)
        {
            if (ruleId == null) return null;
            var query = new QueryExpression(Q(SchemaNames.Rule.Entity))
            {
                ColumnSet = new ColumnSet(Q(SchemaNames.Rule.Triggers), Q(SchemaNames.Rule.OnDemandScope)),
                TopCount = 1,
            };
            query.Criteria.AddCondition(Q(SchemaNames.Rule.DraftOf), ConditionOperator.Equal, ruleId.Value);
            return system.RetrieveMultiple(query).Entities.FirstOrDefault();
        }
    }
}
