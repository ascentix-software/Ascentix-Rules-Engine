using System;
using System.Collections.Generic;
using System.Linq;

namespace Ascentix.RulesEngine.Plugin.Registration
{
    /// <summary>
    /// Pure: from a table's rule analyses, decides which server steps the table needs
    /// and the Update step's filtering attributes (root-only gated). See spec §5.
    /// </summary>
    public static class StepPlanner
    {
        public static DesiredSteps Plan(IEnumerable<RuleAnalysis> analyses)
        {
            var server = (analyses ?? Enumerable.Empty<RuleAnalysis>())
                .Where(a => a.HasServerAction)
                .ToList();

            var updateRules = server.Where(a => a.OnUpdate).ToList();

            ISet<string> updateFiltering = null;
            if (updateRules.Count > 0 && updateRules.All(a => a.IsRootOnly))
            {
                var union = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var rule in updateRules)
                    foreach (var col in rule.RootColumns)
                        union.Add(col);
                updateFiltering = union;
            }
            // else: updateFiltering stays null => fire on all columns (traversal present),
            // or there are no update rules at all.

            return new DesiredSteps
            {
                Create = server.Any(a => a.OnCreate),
                Update = updateRules.Count > 0,
                Delete = server.Any(a => a.OnDelete),
                UpdateFilteringAttributes = updateFiltering
            };
        }
    }
}
