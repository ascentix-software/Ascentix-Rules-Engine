using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Execution
{
    // ─── Query Result Cache ───────────────────────────────────────────────────

    /// <summary>
    /// Stores query results keyed by TableConfig node ID plus an optional pushdown-variant key
    /// (the pushed predicate's canonical form, from PushedFilter.CanonicalKey). The bare-node
    /// entry is the UNFILTERED variant: it remains the source for traversal (child fetches read
    /// parent ids from it) and for every consumer that doesn't evaluate through a pushed filter.
    /// Filtered variants are evaluation views only. The root triggering record is seeded before
    /// execution begins.
    ///
    /// Reads are honest: a <see cref="Get(Guid)"/> / <see cref="GetIds"/> of an entry that was
    /// never stored THROWS rather than returning an empty list. "Fetched and matched nothing"
    /// (an explicitly stored empty list) and "never fetched" are different facts, and every
    /// consumer that reads through a node the planner failed to demand would otherwise reach a
    /// confident, wrong verdict against an empty collection (an EXISTS counts zero, a RowCount
    /// counts zero, a template renders blank). The planner/executor guarantee that every node a
    /// consumer reads has been stored; the loud read is the safety net when that guarantee is
    /// broken. Use <see cref="Has"/> to ask whether an entry exists without reading it.
    /// </summary>
    public class QueryResultCache
    {
        private readonly Dictionary<string, List<Entity>> _cache = new Dictionary<string, List<Entity>>();
        private readonly TableConfigTree _tree;

        public QueryResultCache() : this(null) { }

        /// <param name="tree">Optional config tree, used only to name the node's table in the
        /// never-fetched fault message.</param>
        public QueryResultCache(TableConfigTree tree)
        {
            _tree = tree;
        }

        public void Store(Guid nodeId, List<Entity> results) =>
            _cache[nodeId.ToString()] = results;

        public void Store(Guid nodeId, string variantKey, List<Entity> results) =>
            _cache[ComposeKey(nodeId, variantKey)] = results;

        /// <summary>The node's UNFILTERED rows. Throws when no query was ever executed for the
        /// node. See the class remarks.</summary>
        public List<Entity> Get(Guid nodeId) => Read(nodeId, null);

        /// <summary>The node's rows under a pushdown variant (a null/empty key reads the
        /// unfiltered entry). Throws when that variant was never executed.</summary>
        public List<Entity> Get(Guid nodeId, string variantKey) => Read(nodeId, variantKey);

        /// <summary>True when the variant (or, for a null/empty key, the unfiltered entry)
        /// was actually executed and stored, including a fetch that matched nothing.</summary>
        public bool Has(Guid nodeId, string variantKey = null) =>
            _cache.ContainsKey(ComposeKey(nodeId, variantKey));

        /// <summary>Ids of the node's UNFILTERED rows. Throws when the node was never fetched.</summary>
        public IEnumerable<Guid> GetIds(Guid nodeId) =>
            Get(nodeId).Select(e => e.Id);

        private List<Entity> Read(Guid nodeId, string variantKey)
        {
            if (_cache.TryGetValue(ComposeKey(nodeId, variantKey), out var results))
                return results;

            var table = _tree != null && _tree.TryGetNode(nodeId, out var node) && node != null
                ? node.TableLogicalName ?? "?"
                : "?";
            var variant = string.IsNullOrEmpty(variantKey) ? "unfiltered" : $"variant '{variantKey}'";
            throw new InvalidPluginExecutionException(
                $"Result cache read of node {nodeId} ('{table}', {variant}), but no query was executed " +
                "for it, so its rows are unknown. This is an engine planning fault, not a rule error: " +
                "evaluating it would silently treat the node as an empty collection.");
        }

        private static string ComposeKey(Guid nodeId, string variantKey) =>
            string.IsNullOrEmpty(variantKey) ? nodeId.ToString() : nodeId.ToString() + "|" + variantKey;
    }
}
