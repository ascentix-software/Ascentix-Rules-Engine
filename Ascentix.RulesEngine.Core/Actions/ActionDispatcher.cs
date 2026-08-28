using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Localization;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Actions
{
    // ─── Action Dispatcher ────────────────────────────────────────────────────

    /// <summary>
    /// Pure action-firing logic. Given a rule's match result and its actions,
    /// returns the active actions that fire (in execution order) and the blocking
    /// (Block) messages among them. No service calls, therefore unit-testable.
    /// </summary>
    public static class ActionDispatcher
    {
        /// <summary>
        /// Formats fired Block messages (already resolved strings) as a localized header
        /// followed by a deduped bulleted list. Order of first appearance is preserved.
        /// </summary>
        public static string FormatBlockMessage(IEnumerable<string> messages, int languageId)
        {
            var def = EngineStrings.DefaultBlockMessage(languageId);
            var lines = (messages ?? Enumerable.Empty<string>())
                .Select(m => string.IsNullOrWhiteSpace(m) ? def : m.Trim())
                .Distinct()
                .ToList();

            if (lines.Count == 0) return def;

            return EngineStrings.Header(languageId) + System.Environment.NewLine +
                   string.Join(System.Environment.NewLine, lines.Select(l => " • " + l));
        }

        /// <summary>
        /// Returns the active actions that fire for the given match result, in execution order.
        /// <paramref name="matched"/> is true when the rule's condition tree is satisfied
        /// (i.e. the rule's group(s) evaluated Passed). Block/OnNoMatch therefore fires
        /// when <paramref name="matched"/> is false.
        /// </summary>
        public static List<RuleAction> ComputeFiredActions(bool matched, IEnumerable<RuleAction> actions)
        {
            if (actions == null) return new List<RuleAction>();
            return actions
                .Where(a => a.IsActive)
                .Where(a => Fires(a.FireOn, matched))
                .OrderBy(a => a.Order)
                .ToList();
        }

        public static List<string> GetBlockingMessages(IEnumerable<RuleAction> firedActions, int languageId)
        {
            if (firedActions == null) return new List<string>();
            return firedActions
                .Where(a => a.ActionType == ActionType.Block)
                .Select(a => MessageResolver.Resolve(a, languageId))
                .ToList();
        }

        /// <summary>
        /// True when the action type produces a server-side effect that requires the
        /// plugin to run on the operation. Today only Block throws server-side;
        /// CreateRecord joins this set when its dispatch is implemented (phase 2).
        /// </summary>
        public static bool IsServerAction(ActionType type) =>
            type == ActionType.Block ||
            type == ActionType.CreateRecord ||
            type == ActionType.UpdateRecord ||
            type == ActionType.DeleteRecord;

        private static bool Fires(ActionFireOn fireOn, bool matched) =>
            (fireOn == ActionFireOn.OnMatch && matched) ||
            (fireOn == ActionFireOn.OnNoMatch && !matched);
    }
}
