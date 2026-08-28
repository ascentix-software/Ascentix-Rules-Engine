using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Execution
{
    // ─── Execution Plan ───────────────────────────────────────────────────────

    /// <summary>A pushdown variant demanded for a node: the same parent-scoped fetch with the
    /// pushed predicate appended, cached under (nodeId, Key). See PushdownTranslator.</summary>
    public class NodeQueryVariant
    {
        /// <summary>Cache-variant identity (PushedFilter.CanonicalKey()).</summary>
        public string Key { get; set; }

        /// <summary>The pushed predicate as a FetchXML &lt;filter&gt; fragment
        /// (PushedFilter.ToFetchXml()), nested inside the fetch's link filter.</summary>
        public string FilterFetchXml { get; set; }
    }

    /// <summary>
    /// A single node to query. ParentCacheKey is pre-resolved at plan-build time.
    /// </summary>
    public class ExecutionPlanEntry
    {
        public TableConfig Node { get; set; }

        /// <summary>
        /// String representation of the parent node's ID.
        /// Used by the executor to look up parent results from the cache.
        /// </summary>
        public string ParentCacheKey { get; set; }

        /// <summary>
        /// Whether the UNFILTERED fetch runs for this node. True by default (traversal and all
        /// legacy consumers read it). The pushdown planner clears it only when it can prove every
        /// consumer of the node evaluates through a fully-pushed variant, the node parents no
        /// other planned node, and nothing else references it. That proof is what lets a rule
        /// touch a multi-million-row collection without materializing it.
        /// </summary>
        public bool DemandsUnfiltered { get; set; } = true;

        /// <summary>Filtered variants demanded by pushed-filter consumers (deduplicated by Key).</summary>
        public List<NodeQueryVariant> Variants { get; set; } = new List<NodeQueryVariant>();

        /// <summary>Column pruning: when non-null, child-table fetches request exactly
        /// these attributes instead of all-attributes. Null ⇒ full width (the safe default; see
        /// TraversalColumnCollector's safety model).</summary>
        public HashSet<string> Columns { get; set; }
    }

    /// <summary>
    /// Deduplicates referenced nodes by ID and groups them by depth (shallow first).
    /// Ensures every parent's cache is populated before any child query runs.
    /// </summary>
    public class QueryExecutionPlan
    {
        /// <summary>
        /// Nodes grouped by depth, ordered ascending.
        /// Each level is fully executed before the next begins.
        /// </summary>
        public List<List<ExecutionPlanEntry>> Levels { get; set; } = new List<List<ExecutionPlanEntry>>();

        public static QueryExecutionPlan Build(
            TableConfigTree tree,
            List<RuleCondition> conditions)
            => Build(tree, conditions, null);

        public static QueryExecutionPlan Build(
            TableConfigTree tree,
            List<RuleCondition> conditions,
            IEnumerable<Guid> extraNodeIds)
        {
            tree = tree ?? TableConfigTree.Empty;

            // LHS nodes, cross-node RHS field-ref nodes, and extra (action/filter-seeded) nodes
            // are added with their full ancestor chains, so every hop between a node and the root is
            // queried before it. A LHS node must never be added bare: a condition on a depth-2
            // node whose intermediate ancestor nothing else references would be planned with an
            // unfetched parent, so the executor would scope the child fetch to an empty parent
            // set and the condition would evaluate against zero rows (a never-fetched read fails
            // loudly).
            var nodeIds = new HashSet<Guid>();
            foreach (var condition in conditions)
            {
                AddNodeAndAncestors(condition.TableConfigNodeId, tree, nodeIds);

                if (condition.ComparisonValueNodeId.HasValue)
                    AddNodeAndAncestors(condition.ComparisonValueNodeId.Value, tree, nodeIds);
            }

            if (extraNodeIds != null)
                foreach (var id in extraNodeIds)
                    AddNodeAndAncestors(id, tree, nodeIds);

            var uniqueEntries = nodeIds
                .Select(nodeId => tree.Node(nodeId))
                .Where(node => node.ConfigType != TableConfigType.RootTable)
                .Select(node => new ExecutionPlanEntry
                {
                    Node = node,
                    ParentCacheKey = node.ParentTableId?.ToString()
                })
                .ToList();

            var plan = new QueryExecutionPlan();

            var byDepth = uniqueEntries
                .GroupBy(e => tree.Depth(e.Node.Id))
                .OrderBy(g => g.Key);

            foreach (var level in byDepth)
                plan.Levels.Add(level.ToList());

            return plan;
        }

        // Adds a node and every non-root ancestor on its path to the root (so a lookup-chain
        // RHS has every hop queried before it). The root is seeded, not queried, so it is not
        // added. An id the tree does not hold is skipped here (the loader's seed check and the
        // evaluators' "not in the rule's config tree" errors own that case), but a chain that
        // does not reach a Root Table node is a planning fault and THROWS: planning off a
        // truncated chain leaves the node with an unfetched ancestor, so the executor would
        // scope its fetch to an empty parent set and every consumer would read zero rows with
        // nothing logged.
        private static void AddNodeAndAncestors(Guid nodeId, TableConfigTree tree, HashSet<Guid> acc)
        {
            if (!tree.TryGetNode(nodeId, out var node)) return;

            var diagnosis = tree.ChainDiagnosis(nodeId);
            switch (diagnosis.Shape)
            {
                case ChainShape.Cycle:
                    throw new InvalidPluginExecutionException(
                        $"Query plan: table config node {nodeId} has a cyclic parent chain; " +
                        "the rule cannot be planned.");
                case ChainShape.MissingAncestor:
                    throw new InvalidPluginExecutionException(
                        $"Query plan: table config node {nodeId} ('{node.TableLogicalName}') has a broken parent chain: " +
                        $"node {diagnosis.MissingParentId} is missing from the rule's config tree; the rule cannot be planned.");
                case ChainShape.OrphanNonRoot:
                    throw new InvalidPluginExecutionException(
                        $"Query plan: table config node {nodeId} ('{node.TableLogicalName}') has a broken parent chain: " +
                        "it does not lead to a Root Table node in the rule's config tree; the rule cannot be planned.");
            }

            foreach (var hop in tree.ChainToRoot(nodeId))
                if (hop.ConfigType != TableConfigType.RootTable)
                    acc.Add(hop.Id);
        }
    }
}
