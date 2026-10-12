using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Actions
{
    /// <summary>
    /// Which fired write actions write a set of rows. Update, Delete and Deactivate Record on a
    /// collection node write every filtered row of it; Create Record with a collection node creates
    /// one record per filtered row. Any other target (single-cardinality, or none) is a single write,
    /// so a Create that still carries a single-record target from an earlier edit stays one Create.
    /// </summary>
    public static class SetActions
    {
        private static readonly HashSet<string> NotDeactivatable = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "opportunity", "incident", "quote", "salesorder", "invoice",
        };

        public static bool IsSetAction(RuleAction action, TableConfigTree tree)
        {
            if (action == null || !action.TargetNodeId.HasValue) return false;
            switch (action.ActionType)
            {
                case ActionType.CreateRecord:
                case ActionType.UpdateRecord:
                case ActionType.DeleteRecord:
                case ActionType.DeactivateRecord:
                    return (tree ?? TableConfigTree.Empty).IsCollection(action.TargetNodeId.Value);
                default:
                    return false;
            }
        }

        /// <summary>Tables whose state changes only through a dedicated message (win/lose, close,
        /// fulfil…). Deactivate Record refuses them: META_TABLE_NOT_DEACTIVATABLE.</summary>
        public static bool IsNotDeactivatable(string table) =>
            !string.IsNullOrEmpty(table) && NotDeactivatable.Contains(table);
    }
}
