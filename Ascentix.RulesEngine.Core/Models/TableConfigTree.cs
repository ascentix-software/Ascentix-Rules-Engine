using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Models
{
    // ─── Table Config Tree ────────────────────────────────────────────────────

    /// <summary>Shape of a node's parent chain as diagnosed by
    /// <see cref="TableConfigTree.ChainDiagnosis(Guid)"/>. Only <see cref="Ok"/> occurs on a
    /// validated tree; the other shapes exist for the validator and for unvalidated trees.</summary>
    public enum ChainShape
    {
        /// <summary>The chain reaches a Root Table node.</summary>
        Ok,
        /// <summary>The chain revisits a node before reaching a root.</summary>
        Cycle,
        /// <summary>A hop's ParentTableId points at a node that is not in the tree.</summary>
        MissingAncestor,
        /// <summary>A non-root node with no parent terminates the chain (only a Root Table
        /// node terminates a chain; a parentless non-root is malformed).</summary>
        OrphanNonRoot,
    }

    /// <summary>Result of diagnosing one node's parent chain.</summary>
    public sealed class ChainDiagnosis
    {
        internal ChainDiagnosis(ChainShape shape, bool childOnPath, Guid? missingParentId)
        {
            Shape = shape;
            ChildOnPath = childOnPath;
            MissingParentId = missingParentId;
        }

        public ChainShape Shape { get; }

        /// <summary>True when the node itself or any ancestor reached by the walk is a ChildTable
        /// (1:many) node. Set independently of <see cref="Shape"/>: a chain can be both
        /// child-bearing and broken.</summary>
        public bool ChildOnPath { get; }

        /// <summary>The absent parent id, for <see cref="ChainShape.MissingAncestor"/> only.</summary>
        public Guid? MissingParentId { get; }

        public bool IsOk => Shape == ChainShape.Ok;

        /// <summary>The node may be referenced for single-record reads/writes: its chain reaches
        /// the root and no hop is a child (1:many) node.</summary>
        public bool IsSingleCardinality => Shape == ChainShape.Ok && !ChildOnPath;
    }

    /// <summary>One hop of a structural walk up the tree (see
    /// <see cref="TableConfigTree.HopsBetween"/>): the node being left, the column on its rows
    /// that references the parent (ChildTable nodes only), and the parent node's id.</summary>
    public sealed class TreeHop
    {
        internal TreeHop(TableConfig node, Guid parentNodeId)
        {
            Node = node;
            ParentNodeId = parentNodeId;
        }

        public TableConfig Node { get; }
        public string ChildLinkField => Node.ChildLinkField;
        public Guid ParentNodeId { get; }
    }

    /// <summary>
    /// The configuration tree a rule evaluates against: a FOREST of one or more Root Table
    /// nodes and their Lookup / Child descendants (<c>asx_tableconfig</c> rows). Built once at
    /// load; depth, the root set and the parent chains are computed here, and the three shape
    /// validations (no root / cycle / missing parent) run at construction so no per-query walk
    /// has to guard against them again.
    ///
    /// <see cref="FromLoadedNodes"/> is the engine's constructor (validated).
    /// <see cref="FromNodesUnvalidated"/> exists for the validator (which holds an unvalidated
    /// tree and REPORTS a broken shape as an issue) and for negative-shape tests: the queries the
    /// validator runs (<see cref="TrySingleCardinality"/>, <see cref="IsReachableFromRoot"/>,
    /// <see cref="IsSelfOrAncestor"/>, <see cref="IsAllChildLinksToRoot"/>,
    /// <see cref="ChainDiagnosis(Guid)"/>) never throw for a cycle, a missing ancestor or a
    /// parentless non-root; they answer conservatively (false / the diagnosed shape).
    /// <see cref="Empty"/> is legal: a rule that references no node has an empty tree.
    /// </summary>
    public sealed class TableConfigTree
    {
        private static readonly IReadOnlyList<TableConfig> NoNodes = new TableConfig[0];

        private readonly Dictionary<Guid, TableConfig> _nodes;
        private readonly Dictionary<Guid, List<TableConfig>> _children;
        private readonly List<TableConfig> _roots;
        private readonly bool _validated;

        public static readonly TableConfigTree Empty =
            new TableConfigTree(new Dictionary<Guid, TableConfig>(), validated: true);

        private TableConfigTree(Dictionary<Guid, TableConfig> nodes, bool validated)
        {
            _nodes = nodes;
            _validated = validated;
            _roots = nodes.Values.Where(n => n.ConfigType == TableConfigType.RootTable).ToList();
            _children = new Dictionary<Guid, List<TableConfig>>();
            foreach (var node in nodes.Values)
            {
                if (!node.ParentTableId.HasValue) continue;
                if (!_children.TryGetValue(node.ParentTableId.Value, out var list))
                    _children[node.ParentTableId.Value] = list = new List<TableConfig>();
                list.Add(node);
            }
        }

        // ─── Construction ───────────────────────────────────────────────────

        /// <summary>Builds a validated forest from loaded nodes. Throws (as the loader always
        /// has) when the set has no Root Table node, when a parent chain is circular, or when a
        /// non-root node's parent is unset or absent from the set. On success every node's
        /// <see cref="TableConfig.Depth"/> is set (0 = root).</summary>
        public static TableConfigTree FromLoadedNodes(IEnumerable<TableConfig> nodes)
        {
            if (nodes == null) throw new ArgumentNullException(nameof(nodes));
            var map = Index(nodes);

            if (!map.Values.Any(c => c.ConfigType == TableConfigType.RootTable))
                throw new InvalidPluginExecutionException(
                    "Table Config tree has no root node. " +
                    "Ensure all parent chains lead to a Root Table config record.");

            var memo = new Dictionary<Guid, int>();
            foreach (var node in map.Values)
                node.Depth = ValidatedDepth(node, map, memo, new HashSet<Guid>());

            return new TableConfigTree(map, validated: true);
        }

        /// <summary>Builds a forest WITHOUT shape validation, for the validation sweep (which
        /// reports shape problems as issues rather than throwing) and for negative-shape tests.
        /// Depth is best-effort: the number of parent hops that could be followed before reaching
        /// a root, a missing parent, or a revisited node.</summary>
        public static TableConfigTree FromNodesUnvalidated(IEnumerable<TableConfig> nodes)
        {
            if (nodes == null) throw new ArgumentNullException(nameof(nodes));
            var map = Index(nodes);
            foreach (var node in map.Values)
                node.Depth = UnvalidatedDepth(node, map);
            return new TableConfigTree(map, validated: false);
        }

        private static Dictionary<Guid, TableConfig> Index(IEnumerable<TableConfig> nodes)
        {
            var map = new Dictionary<Guid, TableConfig>();
            foreach (var node in nodes)
            {
                if (node == null) continue;
                map[node.Id] = node;
            }
            return map;
        }

        private static int ValidatedDepth(
            TableConfig node, Dictionary<Guid, TableConfig> all, Dictionary<Guid, int> memo, HashSet<Guid> visiting)
        {
            if (node.ConfigType == TableConfigType.RootTable) return 0;
            if (memo.TryGetValue(node.Id, out var known)) return known;

            if (!visiting.Add(node.Id))
                throw new InvalidPluginExecutionException(
                    $"Circular reference detected in Table Config tree at node {node.Id}.");

            if (!node.ParentTableId.HasValue || !all.TryGetValue(node.ParentTableId.Value, out var parent))
                throw new InvalidPluginExecutionException(
                    $"Table Config tree: node {node.Id} ('{node.TableLogicalName}') has a missing or unset " +
                    "parent table; the config cannot be loaded.");

            var depth = 1 + ValidatedDepth(parent, all, memo, visiting);
            memo[node.Id] = depth;
            return depth;
        }

        private static int UnvalidatedDepth(TableConfig node, Dictionary<Guid, TableConfig> all)
        {
            var depth = 0;
            var seen = new HashSet<Guid>();
            var current = node;
            while (current.ConfigType != TableConfigType.RootTable
                   && seen.Add(current.Id)
                   && current.ParentTableId.HasValue
                   && all.TryGetValue(current.ParentTableId.Value, out var parent))
            {
                depth++;
                current = parent;
            }
            return depth;
        }

        // ─── Enumeration ────────────────────────────────────────────────────

        public int Count => _nodes.Count;

        public IEnumerable<TableConfig> Nodes => _nodes.Values;

        /// <summary>Every Root Table node, in load order.</summary>
        public IReadOnlyList<TableConfig> Roots => _roots;

        public bool Contains(Guid id) => _nodes.ContainsKey(id);

        public bool TryGetNode(Guid id, out TableConfig node) => _nodes.TryGetValue(id, out node);

        /// <summary>The node with this id; throws the engine's node-not-in-tree error when the id
        /// is unknown (a rule referencing a node that was never seeded into the tree).</summary>
        public TableConfig Node(Guid id)
        {
            if (!_nodes.TryGetValue(id, out var node)) throw NodeNotInTree(id);
            return node;
        }

        public IEnumerable<TableConfig> NodesOfType(TableConfigType type) =>
            _nodes.Values.Where(n => n.ConfigType == type);

        /// <summary>Direct children of a node (reverse edges are indexed at construction). Empty
        /// for a leaf or an unknown id.</summary>
        public IReadOnlyList<TableConfig> ChildrenOf(Guid id) =>
            _children.TryGetValue(id, out var list) ? (IReadOnlyList<TableConfig>)list : NoNodes;

        public IEnumerable<TableConfig> ChildrenOf(Guid id, TableConfigType type) =>
            ChildrenOf(id).Where(n => n.ConfigType == type);

        /// <summary>Root nodes whose table is <paramref name="logicalName"/> (case-insensitive).
        /// A table may have more than one tree, so this is a set.</summary>
        public IReadOnlyList<TableConfig> RootsForTable(string logicalName) =>
            _roots.Where(r => string.Equals(r.TableLogicalName, logicalName, StringComparison.OrdinalIgnoreCase)).ToList();

        // ─── Structure ──────────────────────────────────────────────────────

        /// <summary>The node's parent, or null when it has none (a root) or, on an unvalidated
        /// tree, when the parent is absent.</summary>
        public TableConfig Parent(Guid id)
        {
            var node = Node(id);
            if (!node.ParentTableId.HasValue) return null;
            return _nodes.TryGetValue(node.ParentTableId.Value, out var parent) ? parent : null;
        }

        /// <summary>0 for a root, 1 for a direct child of a root, and so on.</summary>
        public int Depth(Guid id) => Node(id).Depth;

        /// <summary>The parent chain, root-first, ending with the node itself. On an unvalidated
        /// tree the chain stops where it breaks (missing parent or revisited node).</summary>
        public IReadOnlyList<TableConfig> ChainToRoot(Guid id)
        {
            var chain = new List<TableConfig>();
            var seen = new HashSet<Guid>();
            var current = Node(id);
            while (current != null && seen.Add(current.Id))
            {
                chain.Add(current);
                if (current.ConfigType == TableConfigType.RootTable || !current.ParentTableId.HasValue) break;
                _nodes.TryGetValue(current.ParentTableId.Value, out current);
            }
            chain.Reverse();
            return chain;
        }

        /// <summary>The Root Table node the chain reaches, or null when it reaches none
        /// (only possible on an unvalidated tree).</summary>
        public TableConfig RootOf(Guid id)
        {
            var top = ChainToRoot(id)[0];
            return top.ConfigType == TableConfigType.RootTable ? top : null;
        }

        public bool IsReachableFromRoot(Guid id) => Contains(id) && RootOf(id) != null;

        /// <summary>True when <paramref name="ancestorId"/> is <paramref name="descendantId"/>
        /// itself (reflexive: identity does not depend on membership) or lies on its parent
        /// chain. On an unvalidated tree the chain stops where it breaks, so an ancestor beyond a
        /// gap or a cycle is not found (the conservative answer).</summary>
        public bool IsSelfOrAncestor(Guid ancestorId, Guid descendantId)
        {
            if (ancestorId == descendantId) return true;
            if (!Contains(descendantId)) return false;
            return ChainToRoot(descendantId).Any(n => n.Id == ancestorId);
        }

        /// <summary>True when the node is at least one hop below a root and every hop on the way
        /// up is a ChildTable (1:many) node, the shape a row-count-at-root-create can reason
        /// about structurally.</summary>
        public bool IsAllChildLinksToRoot(Guid id)
        {
            if (!TryGetNode(id, out var node) || node.ConfigType == TableConfigType.RootTable) return false;
            var chain = ChainToRoot(id);
            if (chain[0].ConfigType != TableConfigType.RootTable) return false;
            for (var i = 1; i < chain.Count; i++)
                if (chain[i].ConfigType != TableConfigType.ChildTable) return false;
            return true;
        }

        /// <summary>Lowest common ancestor of two nodes: both are brought to equal depth, then
        /// walked up together. Throws the engine's "no common ancestor" error when the two lie
        /// in different trees of the forest.</summary>
        public Guid Lca(Guid aId, Guid bId)
        {
            var a = Node(aId);
            var b = Node(bId);
            while (a.Depth > b.Depth) a = ParentOrNoCommonAncestor(a, bId);
            while (b.Depth > a.Depth) b = ParentOrNoCommonAncestor(b, aId);
            var seen = _validated ? null : new HashSet<Guid>();
            while (a.Id != b.Id)
            {
                if (seen != null && !seen.Add(a.Id))
                    throw new InvalidPluginExecutionException(
                        $"Config tree walk from {aId} and {bId} did not converge; the parent chain contains a cycle.");
                a = ParentOrNoCommonAncestor(a, bId);
                b = ParentOrNoCommonAncestor(b, aId);
            }
            return a.Id;
        }

        /// <summary>The hops from <paramref name="fromId"/> up to (not including)
        /// <paramref name="toId"/>, nearest first. Empty when the two are the same node. Throws
        /// the "no common ancestor" error when <paramref name="toId"/> is not on the chain.</summary>
        public IReadOnlyList<TreeHop> HopsBetween(Guid fromId, Guid toId)
        {
            var hops = new List<TreeHop>();
            var current = Node(fromId);
            var seen = _validated ? null : new HashSet<Guid>();
            while (current.Id != toId)
            {
                if (seen != null && !seen.Add(current.Id))
                    throw new InvalidPluginExecutionException(
                        $"Config tree walk from {fromId} to {toId} did not converge; the parent chain contains a cycle.");
                if (!current.ParentTableId.HasValue) throw NoCommonAncestor(current, toId);
                var parentId = current.ParentTableId.Value;
                hops.Add(new TreeHop(current, parentId));
                current = Node(parentId);
            }
            return hops;
        }

        // ─── Cardinality ────────────────────────────────────────────────────

        /// <summary>Diagnoses the node's parent chain. On a validated tree the shape is always
        /// <see cref="ChainShape.Ok"/>; <see cref="ChainDiagnosis.ChildOnPath"/> still carries the
        /// cardinality answer.</summary>
        public ChainDiagnosis ChainDiagnosis(Guid id)
        {
            var current = Node(id);
            var seen = new HashSet<Guid>();
            var childOnPath = false;
            while (true)
            {
                if (!seen.Add(current.Id))
                    return new ChainDiagnosis(ChainShape.Cycle, childOnPath, null);
                if (current.ConfigType == TableConfigType.ChildTable) childOnPath = true;
                if (current.ConfigType == TableConfigType.RootTable)
                    return new ChainDiagnosis(ChainShape.Ok, childOnPath, null);
                if (!current.ParentTableId.HasValue)
                    return new ChainDiagnosis(ChainShape.OrphanNonRoot, childOnPath, null);
                var parentId = current.ParentTableId.Value;
                if (!_nodes.TryGetValue(parentId, out current))
                    return new ChainDiagnosis(ChainShape.MissingAncestor, childOnPath, parentId);
            }
        }

        /// <summary>Runtime guard: the node may be referenced for single-record reads/writes only
        /// when neither it nor any ancestor is a child (1:many) node. Throws the engine's
        /// cardinality errors otherwise (fail closed: a broken chain is an error, never "reached
        /// the root"). The child error wins over a chain defect further up, as the hop-by-hop
        /// walk always has.</summary>
        public void RequireSingleCardinality(Guid id, string errorContext)
        {
            var node = Node(id);
            var diagnosis = ChainDiagnosis(id);
            if (diagnosis.ChildOnPath)
                throw new InvalidPluginExecutionException(
                    $"{errorContext}: node '{node.TableLogicalName}' is under a 1:many (child) relationship; " +
                    "only the root or a single-cardinality lookup chain can be referenced here.");
            switch (diagnosis.Shape)
            {
                case ChainShape.Cycle:
                    throw new InvalidPluginExecutionException(
                        $"{errorContext}: node '{node.TableLogicalName}' has a cyclic parent chain in the rule's config tree.");
                case ChainShape.MissingAncestor:
                    throw new InvalidPluginExecutionException(
                        $"{errorContext}: node '{node.TableLogicalName}' has a broken parent chain: " +
                        $"node {diagnosis.MissingParentId} is missing from the rule's config tree.");
                case ChainShape.OrphanNonRoot:
                    throw new InvalidPluginExecutionException(
                        $"{errorContext}: node '{node.TableLogicalName}' has a broken parent chain: " +
                        "it does not lead to a Root Table node in the rule's config tree.");
            }
        }

        /// <summary>Validation-sweep guard: never throws; false for every shape that is not a
        /// clean single-cardinality chain to the root (including a parentless non-root and an
        /// unknown id, the conservative answer).</summary>
        public bool TrySingleCardinality(Guid id) =>
            Contains(id) && ChainDiagnosis(id).IsSingleCardinality;

        // ─── Errors ─────────────────────────────────────────────────────────

        private TableConfig ParentOrNoCommonAncestor(TableConfig node, Guid otherId)
        {
            if (!node.ParentTableId.HasValue) throw NoCommonAncestor(node, otherId);
            return Node(node.ParentTableId.Value);
        }

        private static InvalidPluginExecutionException NodeNotInTree(Guid id) =>
            new InvalidPluginExecutionException(
                $"Table config node {id} is not in the rule's config tree; the rule cannot be evaluated. " +
                "This usually means the node was not seeded into the query plan.");

        private static InvalidPluginExecutionException NoCommonAncestor(TableConfig node, Guid otherId) =>
            new InvalidPluginExecutionException(
                $"Nodes '{node.TableLogicalName}' and {otherId} have no common ancestor in the config tree; " +
                "an Exists criterion can only target a collection that shares an ancestor with its condition.");
    }
}
