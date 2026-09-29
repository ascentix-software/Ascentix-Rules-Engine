using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>
    /// "Also apply to the previous parent": when a save changes a lookup on the saved record, a
    /// rule's ticked Update Record actions in that lookup's branch run a second time for the
    /// record the lookup pointed to before the save. This class holds the eligibility rule and
    /// which lookups changed.
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

        /// <summary>The root-level lookups this save changed that ticked actions re-run for, each with
        /// its previous value. Empty when <paramref name="saved"/> is null (Create), the lookup column is
        /// not in <paramref name="overlay"/>, the value is unchanged, or the previous value is empty.</summary>
        public static IReadOnlyList<ChangedLookup> Changed(TableConfigTree tree, IEnumerable<RuleAction> actions,
            Entity saved, Entity overlay)
        {
            var result = new List<ChangedLookup>();
            if (saved == null || overlay == null) return result;
            var seen = new HashSet<Guid>();
            foreach (var action in actions ?? Enumerable.Empty<RuleAction>())
            {
                var lookup = LookupFor(action, tree);
                if (lookup == null || !seen.Add(lookup.Id)) continue;
                var column = lookup.LookupColumnLogicalName;
                if (string.IsNullOrWhiteSpace(column) || !overlay.Attributes.ContainsKey(column)) continue;
                var previous = saved.GetAttributeValue<EntityReference>(column);
                var current = overlay.GetAttributeValue<EntityReference>(column);
                if (previous == null || (current != null && current.Id == previous.Id)) continue;
                result.Add(new ChangedLookup(lookup, previous));
            }
            return result;
        }

        /// <summary>The root for run 2: a copy of <paramref name="root"/> (the record as it will be
        /// saved) with the changed lookup pointed at its previous value.</summary>
        public static Entity RootFor(Entity root, ChangedLookup changed)
        {
            var copy = new Entity(root.LogicalName, root.Id);
            foreach (var attr in root.Attributes) copy[attr.Key] = attr.Value;
            copy[changed.Lookup.LookupColumnLogicalName] = changed.Previous;
            return copy;
        }
    }

    /// <summary>A root-level lookup the save changed, and the record it pointed to before.</summary>
    public sealed class ChangedLookup
    {
        public ChangedLookup(TableConfig lookup, EntityReference previous)
        {
            Lookup = lookup;
            Previous = previous;
        }

        public TableConfig Lookup { get; }
        public EntityReference Previous { get; }
    }
}
