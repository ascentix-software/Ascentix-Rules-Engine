using System;
using System.Collections.Generic;
using System.Linq;

namespace Ascentix.RulesEngine.Plugin.Registration
{
    /// <summary>
    /// Diffs the desired steps for a table against the existing engine-owned steps and
    /// applies create / update-filtering / delete. Resolves each trigger to its single
    /// or Multiple message via the environment's support check. See spec §6.
    /// </summary>
    public static class StepReconciler
    {
        public static void Reconcile(IRegistrationEnvironment env, string table, DesiredSteps desired)
        {
            // Desired message -> filtering-attributes string (null = fire on all).
            var desiredByMessage = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            if (desired.Create)
                desiredByMessage[Resolve(env, "CreateMultiple", "Create", table)] = null;
            if (desired.Update)
                desiredByMessage[Resolve(env, "UpdateMultiple", "Update", table)] =
                    ToFilterString(desired.UpdateFilteringAttributes);
            if (desired.Delete)
                desiredByMessage["Delete"] = null;

            var existing = env.GetEngineSteps(table) ?? new List<RegisteredStep>();

            // Create or update.
            foreach (var pair in desiredByMessage)
            {
                var match = existing.FirstOrDefault(
                    s => string.Equals(s.MessageName, pair.Key, StringComparison.OrdinalIgnoreCase));
                if (match == null)
                {
                    env.CreateStep(new StepRegistration
                    {
                        TableLogicalName = table,
                        MessageName = pair.Key,
                        FilteringAttributes = pair.Value
                    });
                }
                else if (!FilteringEquals(match.FilteringAttributes, pair.Value))
                {
                    env.UpdateFilteringAttributes(match.Id, pair.Value);
                }
            }

            // Delete engine steps no longer desired.
            foreach (var step in existing)
                if (!desiredByMessage.ContainsKey(step.MessageName))
                    env.DeleteStep(step.Id);
        }

        private static string Resolve(IRegistrationEnvironment env, string multiple, string single, string table) =>
            env.SupportsMessage(multiple, table) ? multiple : single;

        // Sorted, comma-joined; null/empty set => null (fire on all).
        private static string ToFilterString(ISet<string> attrs)
        {
            if (attrs == null || attrs.Count == 0) return null;
            return string.Join(",", attrs.OrderBy(a => a, StringComparer.OrdinalIgnoreCase));
        }

        // Order-insensitive comparison of two filtering-attribute strings.
        private static bool FilteringEquals(string a, string b)
        {
            return Normalize(a).SequenceEqual(Normalize(b));
        }

        private static IEnumerable<string> Normalize(string csv) =>
            string.IsNullOrWhiteSpace(csv)
                ? Enumerable.Empty<string>()
                : csv.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0)
                     .OrderBy(s => s, StringComparer.OrdinalIgnoreCase);
    }
}
