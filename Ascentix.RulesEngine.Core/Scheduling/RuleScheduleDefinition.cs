using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Scheduling
{
    /// <summary>
    /// A rule schedule's recurrence, independent of Dataverse: what ScheduleCalculator needs to
    /// compute a next run. Days of week are stored on the entity as a multi-select choice
    /// (OptionSetValueCollection values 0-6, mapping to System.DayOfWeek).
    /// </summary>
    public sealed class RuleScheduleDefinition
    {
        public SchedulePattern Pattern { get; set; }

        /// <summary>EveryMinutes/EveryHours: the N.</summary>
        public int? Every { get; set; }

        /// <summary>Daily/Weekly/Monthly: "HH:mm" (24-hour), in the rule's time zone.</summary>
        public string TimeOfDay { get; set; }

        /// <summary>Weekly: the days the schedule fires on.</summary>
        public IReadOnlyCollection<DayOfWeek> Days { get; set; } = new DayOfWeek[0];

        /// <summary>Monthly: 1-31; clamped to the target month's last day.</summary>
        public int? DayOfMonth { get; set; }

        public static RuleScheduleDefinition FromEntity(Entity schedule)
        {
            var pattern = schedule.GetAttributeValue<OptionSetValue>(SchemaNames.Qualify(SchemaNames.RuleSchedule.Pattern));
            var days = schedule.GetAttributeValue<OptionSetValueCollection>(SchemaNames.Qualify(SchemaNames.RuleSchedule.DaysOfWeek));

            return new RuleScheduleDefinition
            {
                Pattern = (SchedulePattern)(pattern?.Value ?? 0),
                Every = schedule.GetAttributeValue<int?>(SchemaNames.Qualify(SchemaNames.RuleSchedule.Every)),
                TimeOfDay = schedule.GetAttributeValue<string>(SchemaNames.Qualify(SchemaNames.RuleSchedule.TimeOfDay)),
                Days = (days?.Select(v => (DayOfWeek)v.Value).ToArray()) ?? new DayOfWeek[0],
                DayOfMonth = schedule.GetAttributeValue<int?>(SchemaNames.Qualify(SchemaNames.RuleSchedule.DayOfMonth))
            };
        }
    }
}
