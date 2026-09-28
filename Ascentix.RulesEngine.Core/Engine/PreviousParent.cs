using System;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// "Also apply to the previous parent": when a save changes a lookup on the saved record, a
    /// rule's ticked Update Record actions in that lookup's branch run a second time for the
    /// record the lookup pointed to before the save. This class holds the eligibility rule and,
    /// from Task 3, which lookups changed.
    /// </summary>
    public static class PreviousParent
    {
        /// <summary>The root-level lookup at or above <paramref name="nodeId"/>: the chain from the
        /// root must be Root → Lookup (→ Lookup …) down to the node. Null for the root itself, a
        /// collection, anything below a collection, or an unknown node.</summary>
        public static TableConfig RootLookupOf(TableConfigTree tree, Guid nodeId)
        {
            if (tree == null || !tree.TryGetNode(nodeId, out _)) return null;
            var chain = tree.ChainToRoot(nodeId);
            if (chain.Count < 2 || chain[0].ConfigType != TableConfigType.RootTable) return null;
            for (var i = 1; i < chain.Count; i++)
                if (chain[i].ConfigType != TableConfigType.LookupTable) return null;
            return chain[1];
        }

        /// <summary>The root-level lookup this action re-runs for, or null when the action does not
        /// take part (not ticked, inactive, not Update Record, or not in a lookup branch).</summary>
        public static TableConfig LookupFor(RuleAction action, TableConfigTree tree) =>
            action != null && action.IsActive && action.ApplyToPrevious
                && action.ActionType == ActionType.UpdateRecord && action.TargetNodeId.HasValue
                ? RootLookupOf(tree, action.TargetNodeId.Value)
                : null;
    }
}
