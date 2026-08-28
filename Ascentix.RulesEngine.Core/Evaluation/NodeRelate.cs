using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Evaluation
{
    // ─── Node Relate ──────────────────────────────────────────────────────────

    /// <summary>
    /// The DATA half of EXISTS predicate evaluation: walking a row up the parent chain (via
    /// each hop's ChildLinkField) to the instance id of a given ancestor node. The STRUCTURE
    /// half (which hops lie between two nodes, their lowest common ancestor, the cycle guard
    /// and the "no common ancestor" error) is owned by <see cref="TableConfigTree"/>
    /// (<see cref="TableConfigTree.HopsBetween"/>, <see cref="TableConfigTree.Lca"/>).
    /// </summary>
    public static class NodeRelate
    {
        /// <summary>Walks <paramref name="record"/> (a row of <paramref name="fromNodeId"/>) up
        /// to the <paramref name="toNodeId"/> ancestor level and returns that ancestor's
        /// instance id. Null when the row cannot be related (an unrelatable row counts
        /// as zero): a hop with no ChildLinkField, a null parent reference, or a parent ROW
        /// absent from a fetched set. A parent ENTRY that was never fetched is a planning fault
        /// and the cache read throws.</summary>
        public static Guid? AncestorInstanceId(Entity record, Guid fromNodeId, Guid toNodeId,
            QueryResultCache cache, TableConfigTree tree)
        {
            if (fromNodeId == toNodeId) return record.Id;

            var current = record;
            foreach (var hop in tree.HopsBetween(fromNodeId, toNodeId))
            {
                if (string.IsNullOrEmpty(hop.ChildLinkField)) return null;
                var parentRef = current.GetAttributeValue<EntityReference>(hop.ChildLinkField);
                if (parentRef == null) return null;
                if (hop.ParentNodeId == toNodeId) return parentRef.Id;
                // Two different absences meet here. The parent ENTRY never having been fetched is
                // a planning fault (the planner adds every hop between a node and its ancestors),
                // and the cache read throws for it. The parent ROW being absent from a fetched
                // set is legitimate (the row's ancestor fell outside the traversal, so an
                // unrelatable row counts as zero) and returns null.
                var parentRec = cache.Get(hop.ParentNodeId).FirstOrDefault(e => e.Id == parentRef.Id);
                if (parentRec == null) return null;
                current = parentRec;
            }
            return current.Id;
        }
    }
}
