using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Plugin.DataUpdates
{
    /// <summary>The publish gate's check: no rule is published while a data update is pending.</summary>
    public static class DataUpdateGate
    {
        /// <summary>The lowest-numbered pending update, or null. Reads nothing when there are no updates.</summary>
        public static IDataUpdate FirstPending(IOrganizationService system, IReadOnlyList<IDataUpdate> updates)
        {
            if (updates.Count == 0) return null;
            var rows = DataUpdateRows.Load(system);
            return updates.OrderBy(u => u.Number)
                .FirstOrDefault(u => DataUpdateRows.IsPending(rows.TryGetValue(u.Number, out var row) ? row : null));
        }

        public static string PublishRefusal(int number) =>
            $"An administrator must apply data update {number} before rules can be published.";
    }
}
