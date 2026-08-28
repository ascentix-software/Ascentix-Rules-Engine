using System;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>The single-cardinality guard every single-record read/write goes through:
    /// <see cref="TableConfigTree.RequireSingleCardinality"/> (runtime: throws) and
    /// <see cref="TableConfigTree.TrySingleCardinality"/> (never throws; false is the conservative
    /// answer). Formerly the static NodeCardinality class; its message contracts are pinned here.
    /// Reached indirectly via TemplateRendererTests.Child_node_token_throws and
    /// MathExprEvaluatorTests.Aggregate_node_must_be_a_collection.</summary>
    public class NodeCardinalityTests
    {
        [Fact]
        public void Root_is_single()
        {
            var rootId = Guid.NewGuid();
            var root = TestTree.Node(rootId, "account", TableConfigType.RootTable, null);
            var tree = TestTree.Tree(root);

            Assert.True(tree.TrySingleCardinality(rootId));
            tree.RequireSingleCardinality(rootId, "test"); // does not throw
        }

        [Fact]
        public void Lookup_under_root_is_single()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var root = TestTree.Node(rootId, "account", TableConfigType.RootTable, null);
            var lookup = TestTree.Node(lookupId, "contact", TableConfigType.LookupTable, rootId);
            var tree = TestTree.Tree(root, lookup);

            Assert.True(tree.TrySingleCardinality(lookupId));
            tree.RequireSingleCardinality(lookupId, "test"); // does not throw
        }

        [Fact]
        public void Child_table_is_not_single_and_Require_throws()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var root = TestTree.Node(rootId, "account", TableConfigType.RootTable, null);
            var child = TestTree.Node(childId, "task", TableConfigType.ChildTable, rootId);
            var tree = TestTree.Tree(root, child);

            Assert.False(tree.TrySingleCardinality(childId));
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                tree.RequireSingleCardinality(childId, "test"));
            Assert.Contains("1:many", ex.Message);
            Assert.StartsWith("test: node 'task'", ex.Message);
        }

        [Fact]
        public void Lookup_whose_ancestor_is_a_child_is_not_single()
        {
            // Lookup -> Child -> Root: the multi-hop walk where the lookup's *ancestor* (not the
            // lookup itself) is the child node that makes the whole chain not single-cardinality.
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var root = TestTree.Node(rootId, "account", TableConfigType.RootTable, null);
            var child = TestTree.Node(childId, "task", TableConfigType.ChildTable, rootId);
            var lookup = TestTree.Node(lookupId, "contact", TableConfigType.LookupTable, childId);
            var tree = TestTree.Tree(root, child, lookup);

            Assert.False(tree.TrySingleCardinality(lookupId));
            Assert.Throws<InvalidPluginExecutionException>(() =>
                tree.RequireSingleCardinality(lookupId, "test"));
        }

        [Fact]
        public void Broken_parent_chain_throws_rather_than_silently_allowing_the_reference()
        {
            // ParentTableId points at a node absent from the tree. Fail-open default on a guard:
            // Require must throw naming the missing node and the walk's starting node, not
            // treat the truncated walk as "reached the root".
            var nodeId = Guid.NewGuid();
            var missingParentId = Guid.NewGuid();
            var orphan = TestTree.Node(nodeId, "contact", TableConfigType.LookupTable, missingParentId);
            var tree = TestTree.RawTree(orphan);

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => tree.RequireSingleCardinality(nodeId, "test"));
            Assert.Contains("config tree", ex.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Contains(missingParentId.ToString(), ex.Message);
        }

        [Fact]
        public void Try_on_a_broken_parent_chain_is_false_not_a_throw()
        {
            // The validation sweep's answer: it collects every issue, so the guard must not throw
            // mid-sweep, and "not single" is the conservative verdict for a chain that never reaches
            // a root. The runtime façade above still names the break.
            var nodeId = Guid.NewGuid();
            var orphan = TestTree.Node(nodeId, "contact", TableConfigType.LookupTable, Guid.NewGuid());
            var tree = TestTree.RawTree(orphan);

            Assert.False(tree.TrySingleCardinality(nodeId));
        }

        [Fact]
        public void Parentless_non_root_is_malformed_not_single()
        {
            // Only a Root Table node terminates a chain. A lookup with no parent at all must
            // not read as "reached the root" (single); it is a broken chain.
            var nodeId = Guid.NewGuid();
            var lone = TestTree.Node(nodeId, "contact", TableConfigType.LookupTable, null);
            var tree = TestTree.RawTree(lone);

            Assert.False(tree.TrySingleCardinality(nodeId));
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => tree.RequireSingleCardinality(nodeId, "test"));
            Assert.Contains("config tree", ex.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("Root Table", ex.Message);
        }

        [Fact]
        public void Require_on_a_cyclic_parent_chain_throws_instead_of_hanging()
        {
            // A -> B -> A, both single-cardinality lookups (not child, not root). Without the
            // seen-set this loops forever; the diagnosis breaks on the second visit and throws.
            var a = Guid.NewGuid();
            var b = Guid.NewGuid();
            var nodeA = TestTree.Node(a, "a", TableConfigType.LookupTable, b);
            var nodeB = TestTree.Node(b, "b", TableConfigType.LookupTable, a);
            var tree = TestTree.RawTree(nodeA, nodeB);

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => tree.RequireSingleCardinality(a, "ctx"));
            Assert.Contains("cyclic", ex.Message, StringComparison.OrdinalIgnoreCase);
            Assert.StartsWith("ctx: node 'a'", ex.Message);
        }

        [Fact]
        public void Try_on_a_cyclic_parent_chain_is_false_and_terminates()
        {
            var a = Guid.NewGuid();
            var b = Guid.NewGuid();
            var nodeA = TestTree.Node(a, "a", TableConfigType.LookupTable, b);
            var nodeB = TestTree.Node(b, "b", TableConfigType.LookupTable, a);
            var tree = TestTree.RawTree(nodeA, nodeB);

            Assert.False(tree.TrySingleCardinality(a));
            Assert.Equal(ChainShape.Cycle, tree.ChainDiagnosis(a).Shape);
        }

        [Fact]
        public void Unknown_node_is_not_single_and_Require_names_the_missing_node()
        {
            var tree = TestTree.Tree(TestTree.Node(Guid.NewGuid(), "account", TableConfigType.RootTable, null));
            var unknown = Guid.NewGuid();

            Assert.False(tree.TrySingleCardinality(unknown));
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => tree.RequireSingleCardinality(unknown, "ctx"));
            Assert.Contains(unknown.ToString(), ex.Message);
            Assert.Contains("not in the rule's config tree", ex.Message);
        }
    }
}
