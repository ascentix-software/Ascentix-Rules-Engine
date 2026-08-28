using System;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>TableConfigTree: the forest the engine evaluates against. Construction validates
    /// the shape once (no root / cycle / missing parent: the loader's three errors, preserved
    /// verbatim) and owns depth; the structure queries replace the per-consumer parent walks.</summary>
    public class TableConfigTreeTests
    {
        // root(order) ─┬─ child(line, "line_orderid") ── child(linenote, "linenote_lineid")
        //              ├─ child(shipment, "shipment_orderid")
        //              └─ lookup(customer) ── lookup(region)
        private sealed class Shape
        {
            public Guid Order = Guid.NewGuid(), Line = Guid.NewGuid(), LineNote = Guid.NewGuid(),
                        Shipment = Guid.NewGuid(), Customer = Guid.NewGuid(), Region = Guid.NewGuid();

            public TableConfig[] Nodes() => new[]
            {
                TestTree.Node(Order, "sample_order", TableConfigType.RootTable, null),
                TestTree.Node(Line, "sample_orderline", TableConfigType.ChildTable, Order, "line_orderid"),
                TestTree.Node(LineNote, "sample_linenote", TableConfigType.ChildTable, Line, "linenote_lineid"),
                TestTree.Node(Shipment, "sample_shipment", TableConfigType.ChildTable, Order, "shipment_orderid"),
                TestTree.Node(Customer, "sample_customer", TableConfigType.LookupTable, Order),
                TestTree.Node(Region, "sample_region", TableConfigType.LookupTable, Customer),
            };

            public TableConfigTree Tree() => TestTree.Tree(Nodes());
        }

        // ─── Construction validation (the loader's three errors, verbatim) ─────────

        [Fact]
        public void FromLoadedNodes_without_a_root_throws_the_loader_message()
        {
            var a = Guid.NewGuid();
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                TableConfigTree.FromLoadedNodes(new[] { TestTree.Node(a, "x", TableConfigType.LookupTable, null) }));
            Assert.Contains("Table Config tree has no root node", ex.Message);
            Assert.Contains("Ensure all parent chains lead to a Root Table config record", ex.Message);
        }

        [Fact]
        public void FromLoadedNodes_with_a_cycle_throws_the_loader_message_naming_the_node()
        {
            var root = Guid.NewGuid(); var a = Guid.NewGuid(); var b = Guid.NewGuid();
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                TableConfigTree.FromLoadedNodes(new[]
                {
                    TestTree.Node(root, "r", TableConfigType.RootTable, null),
                    TestTree.Node(a, "a", TableConfigType.LookupTable, b),
                    TestTree.Node(b, "b", TableConfigType.LookupTable, a),
                }));
            Assert.Contains("Circular reference detected in Table Config tree at node", ex.Message);
            Assert.True(ex.Message.Contains(a.ToString()) || ex.Message.Contains(b.ToString()));
        }

        [Fact]
        public void FromLoadedNodes_with_a_missing_parent_throws_the_loader_message()
        {
            var root = Guid.NewGuid(); var orphan = Guid.NewGuid(); var missing = Guid.NewGuid();
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                TableConfigTree.FromLoadedNodes(new[]
                {
                    TestTree.Node(root, "r", TableConfigType.RootTable, null),
                    TestTree.Node(orphan, "contact", TableConfigType.LookupTable, missing),
                }));
            Assert.Contains($"Table Config tree: node {orphan} ('contact') has a missing or unset parent table", ex.Message);
            Assert.Contains("the config cannot be loaded", ex.Message);
        }

        [Fact]
        public void FromLoadedNodes_with_an_unset_parent_on_a_non_root_is_the_same_error()
        {
            var root = Guid.NewGuid(); var orphan = Guid.NewGuid();
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                TableConfigTree.FromLoadedNodes(new[]
                {
                    TestTree.Node(root, "r", TableConfigType.RootTable, null),
                    TestTree.Node(orphan, "task", TableConfigType.ChildTable, null, "regardingobjectid"),
                }));
            Assert.Contains("has a missing or unset parent table", ex.Message);
        }

        [Fact]
        public void Empty_is_legal_and_answers_every_query_conservatively()
        {
            var tree = TableConfigTree.Empty;
            Assert.Equal(0, tree.Count);
            Assert.Empty(tree.Roots);
            Assert.Empty(tree.Nodes);
            Assert.Empty(tree.RootsForTable("account"));
            Assert.False(tree.Contains(Guid.NewGuid()));
            Assert.False(tree.IsReachableFromRoot(Guid.NewGuid()));
            Assert.False(tree.TrySingleCardinality(Guid.NewGuid()));
            Assert.Empty(tree.ChildrenOf(Guid.NewGuid()));
        }

        // ─── Depth ─────────────────────────────────────────────────────────────────

        [Fact]
        public void Depth_is_computed_at_construction_and_frozen_on_the_node()
        {
            var s = new Shape();
            var tree = s.Tree();
            Assert.Equal(0, tree.Depth(s.Order));
            Assert.Equal(1, tree.Depth(s.Line));
            Assert.Equal(2, tree.Depth(s.LineNote));
            Assert.Equal(1, tree.Depth(s.Customer));
            Assert.Equal(2, tree.Depth(s.Region));
            // The node carries the same value: consumers that still hold TableConfig read it.
            Assert.Equal(2, tree.Node(s.Region).Depth);
        }

        [Fact]
        public void Depth_on_an_unknown_id_throws_the_node_not_in_tree_error()
        {
            var tree = new Shape().Tree();
            var unknown = Guid.NewGuid();
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => tree.Depth(unknown));
            Assert.Contains($"Table config node {unknown} is not in the rule's config tree", ex.Message);
        }

        // ─── Chains and roots ──────────────────────────────────────────────────────

        [Fact]
        public void ChainToRoot_is_root_first_and_ends_with_the_node()
        {
            var s = new Shape();
            var chain = s.Tree().ChainToRoot(s.LineNote).Select(n => n.Id).ToList();
            Assert.Equal(new[] { s.Order, s.Line, s.LineNote }, chain);
        }

        [Fact]
        public void ChainToRoot_of_a_root_is_just_the_root()
        {
            var s = new Shape();
            Assert.Equal(new[] { s.Order }, s.Tree().ChainToRoot(s.Order).Select(n => n.Id));
        }

        [Fact]
        public void RootOf_returns_the_tree_root_for_any_node()
        {
            var s = new Shape();
            var tree = s.Tree();
            Assert.Equal(s.Order, tree.RootOf(s.Region).Id);
            Assert.Equal(s.Order, tree.RootOf(s.Order).Id);
            Assert.True(tree.IsReachableFromRoot(s.LineNote));
        }

        [Fact]
        public void Parent_is_null_for_a_root_and_the_parent_node_otherwise()
        {
            var s = new Shape();
            var tree = s.Tree();
            Assert.Null(tree.Parent(s.Order));
            Assert.Equal(s.Customer, tree.Parent(s.Region).Id);
        }

        [Fact]
        public void RootsForTable_is_case_insensitive_and_returns_every_root_of_a_forest()
        {
            var a = Guid.NewGuid(); var b = Guid.NewGuid(); var other = Guid.NewGuid();
            var tree = TestTree.Tree(
                TestTree.Node(a, "sample_order", TableConfigType.RootTable, null),
                TestTree.Node(b, "SAMPLE_ORDER", TableConfigType.RootTable, null),
                TestTree.Node(other, "account", TableConfigType.RootTable, null));

            Assert.Equal(3, tree.Roots.Count);
            var orderRoots = tree.RootsForTable("Sample_Order").Select(r => r.Id).ToList();
            Assert.Equal(2, orderRoots.Count);
            Assert.Contains(a, orderRoots);
            Assert.Contains(b, orderRoots);
            Assert.Single(tree.RootsForTable("account"));
            Assert.Empty(tree.RootsForTable("contact"));
        }

        [Fact]
        public void IsSelfOrAncestor_walks_the_chain()
        {
            var s = new Shape();
            var tree = s.Tree();
            Assert.True(tree.IsSelfOrAncestor(s.Order, s.LineNote));
            Assert.True(tree.IsSelfOrAncestor(s.Line, s.LineNote));
            Assert.True(tree.IsSelfOrAncestor(s.LineNote, s.LineNote));
            Assert.False(tree.IsSelfOrAncestor(s.Shipment, s.LineNote));
            Assert.False(tree.IsSelfOrAncestor(s.LineNote, s.Line));
            Assert.False(tree.IsSelfOrAncestor(s.Order, Guid.NewGuid()));
            var unknown = Guid.NewGuid();
            Assert.True(tree.IsSelfOrAncestor(unknown, unknown));   // reflexive, membership aside
        }

        [Fact]
        public void IsAllChildLinksToRoot_requires_at_least_one_hop_and_only_child_hops()
        {
            var s = new Shape();
            var tree = s.Tree();
            Assert.True(tree.IsAllChildLinksToRoot(s.Line));
            Assert.True(tree.IsAllChildLinksToRoot(s.LineNote));
            Assert.False(tree.IsAllChildLinksToRoot(s.Order));      // zero hops
            Assert.False(tree.IsAllChildLinksToRoot(s.Customer));   // lookup hop
            Assert.False(tree.IsAllChildLinksToRoot(s.Region));     // lookup hops
            Assert.False(tree.IsAllChildLinksToRoot(Guid.NewGuid()));
        }

        // ─── Lca / HopsBetween ─────────────────────────────────────────────────────

        [Fact]
        public void Lca_of_siblings_is_the_parent_and_of_an_ancestor_pair_is_the_ancestor()
        {
            var s = new Shape();
            var tree = s.Tree();
            Assert.Equal(s.Order, tree.Lca(s.Line, s.Shipment));
            Assert.Equal(s.Order, tree.Lca(s.LineNote, s.Shipment));
            Assert.Equal(s.Line, tree.Lca(s.LineNote, s.Line));
            Assert.Equal(s.Line, tree.Lca(s.Line, s.LineNote));
            Assert.Equal(s.Region, tree.Lca(s.Region, s.Region));
            Assert.Equal(s.Order, tree.Lca(s.Region, s.LineNote));
        }

        [Fact]
        public void Lca_across_two_trees_of_the_forest_throws_the_no_common_ancestor_error()
        {
            var a = Guid.NewGuid(); var b = Guid.NewGuid();
            var tree = TestTree.Tree(
                TestTree.Node(a, "sample_order", TableConfigType.RootTable, null),
                TestTree.Node(b, "sample_other_root", TableConfigType.RootTable, null));
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => tree.Lca(a, b));
            Assert.Contains("have no common ancestor in the config tree", ex.Message);
            Assert.Contains("an Exists criterion can only target a collection that shares an ancestor", ex.Message);
        }

        [Fact]
        public void HopsBetween_lists_each_hop_nearest_first_with_its_child_link_and_parent()
        {
            var s = new Shape();
            var hops = s.Tree().HopsBetween(s.LineNote, s.Order);
            Assert.Equal(2, hops.Count);
            Assert.Equal(s.LineNote, hops[0].Node.Id);
            Assert.Equal("linenote_lineid", hops[0].ChildLinkField);
            Assert.Equal(s.Line, hops[0].ParentNodeId);
            Assert.Equal(s.Line, hops[1].Node.Id);
            Assert.Equal("line_orderid", hops[1].ChildLinkField);
            Assert.Equal(s.Order, hops[1].ParentNodeId);
        }

        [Fact]
        public void HopsBetween_a_node_and_itself_is_empty_and_to_a_non_ancestor_throws()
        {
            var s = new Shape();
            var tree = s.Tree();
            Assert.Empty(tree.HopsBetween(s.Line, s.Line));
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => tree.HopsBetween(s.Line, s.Shipment));
            Assert.Contains("no common ancestor", ex.Message);
        }

        // ─── ChainDiagnosis and the two façades ───────────────────────────────────

        [Fact]
        public void ChainDiagnosis_is_Ok_on_a_validated_tree_and_reports_a_child_on_the_path()
        {
            var s = new Shape();
            var tree = s.Tree();
            var lookup = tree.ChainDiagnosis(s.Region);
            Assert.Equal(ChainShape.Ok, lookup.Shape);
            Assert.False(lookup.ChildOnPath);
            Assert.True(lookup.IsSingleCardinality);

            var underChild = tree.ChainDiagnosis(s.LineNote);
            Assert.Equal(ChainShape.Ok, underChild.Shape);
            Assert.True(underChild.ChildOnPath);
            Assert.False(underChild.IsSingleCardinality);
        }

        [Fact]
        public void ChainDiagnosis_reports_a_cycle()
        {
            var a = Guid.NewGuid(); var b = Guid.NewGuid();
            var tree = TestTree.RawTree(
                TestTree.Node(a, "a", TableConfigType.LookupTable, b),
                TestTree.Node(b, "b", TableConfigType.LookupTable, a));
            Assert.Equal(ChainShape.Cycle, tree.ChainDiagnosis(a).Shape);
            Assert.False(tree.TrySingleCardinality(a));
        }

        [Fact]
        public void ChainDiagnosis_reports_a_missing_ancestor_with_its_id()
        {
            var a = Guid.NewGuid(); var missing = Guid.NewGuid();
            var tree = TestTree.RawTree(TestTree.Node(a, "contact", TableConfigType.LookupTable, missing));
            var d = tree.ChainDiagnosis(a);
            Assert.Equal(ChainShape.MissingAncestor, d.Shape);
            Assert.Equal(missing, d.MissingParentId);
            Assert.False(tree.TrySingleCardinality(a));
        }

        [Fact]
        public void ChainDiagnosis_reports_a_parentless_non_root_as_an_orphan()
        {
            // Only a Root Table node terminates a chain. A parentless lookup is malformed, and
            // must never be answered as "single" cardinality.
            var a = Guid.NewGuid();
            var tree = TestTree.RawTree(TestTree.Node(a, "contact", TableConfigType.LookupTable, null));
            Assert.Equal(ChainShape.OrphanNonRoot, tree.ChainDiagnosis(a).Shape);
            Assert.False(tree.TrySingleCardinality(a));
        }

        [Fact]
        public void RequireSingleCardinality_passes_for_root_and_lookup_chains()
        {
            var s = new Shape();
            var tree = s.Tree();
            tree.RequireSingleCardinality(s.Order, "ctx");
            tree.RequireSingleCardinality(s.Customer, "ctx");
            tree.RequireSingleCardinality(s.Region, "ctx");
            Assert.True(tree.TrySingleCardinality(s.Region));
        }

        [Fact]
        public void RequireSingleCardinality_throws_the_child_message_for_a_node_under_a_child()
        {
            var s = new Shape();
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => s.Tree().RequireSingleCardinality(s.LineNote, "Template"));
            Assert.Equal("Template: node 'sample_linenote' is under a 1:many (child) relationship; " +
                         "only the root or a single-cardinality lookup chain can be referenced here.", ex.Message);
        }

        [Fact]
        public void RequireSingleCardinality_throws_the_cyclic_message_on_a_cycle()
        {
            var a = Guid.NewGuid(); var b = Guid.NewGuid();
            var tree = TestTree.RawTree(
                TestTree.Node(a, "a", TableConfigType.LookupTable, b),
                TestTree.Node(b, "b", TableConfigType.LookupTable, a));
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => tree.RequireSingleCardinality(a, "ctx"));
            Assert.Equal("ctx: node 'a' has a cyclic parent chain in the rule's config tree.", ex.Message);
        }

        [Fact]
        public void RequireSingleCardinality_throws_the_broken_chain_message_naming_the_missing_node()
        {
            var a = Guid.NewGuid(); var missing = Guid.NewGuid();
            var tree = TestTree.RawTree(TestTree.Node(a, "contact", TableConfigType.LookupTable, missing));
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => tree.RequireSingleCardinality(a, "ctx"));
            Assert.Equal($"ctx: node 'contact' has a broken parent chain: node {missing} is missing from the rule's config tree.", ex.Message);
        }

        [Fact]
        public void RequireSingleCardinality_child_wins_over_a_defect_further_up_the_chain()
        {
            // The hop-by-hop walk always threw the child error before reaching the broken hop.
            var child = Guid.NewGuid(); var missing = Guid.NewGuid();
            var tree = TestTree.RawTree(TestTree.Node(child, "task", TableConfigType.ChildTable, missing, "regardingobjectid"));
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => tree.RequireSingleCardinality(child, "ctx"));
            Assert.Contains("is under a 1:many (child) relationship", ex.Message);
        }

        [Fact]
        public void RequireSingleCardinality_on_an_unknown_node_throws_the_node_not_in_tree_error()
        {
            var unknown = Guid.NewGuid();
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => new Shape().Tree().RequireSingleCardinality(unknown, "ctx"));
            Assert.Contains("is not in the rule's config tree", ex.Message);
        }

        // ─── Enumeration ───────────────────────────────────────────────────────────

        [Fact]
        public void ChildrenOf_returns_direct_children_optionally_filtered_by_type()
        {
            var s = new Shape();
            var tree = s.Tree();
            var all = tree.ChildrenOf(s.Order).Select(n => n.Id).ToList();
            Assert.Equal(3, all.Count);
            Assert.Contains(s.Line, all);
            Assert.Contains(s.Shipment, all);
            Assert.Contains(s.Customer, all);
            Assert.Equal(new[] { s.Customer }, tree.ChildrenOf(s.Order, TableConfigType.LookupTable).Select(n => n.Id));
            Assert.Equal(new[] { s.LineNote }, tree.ChildrenOf(s.Line).Select(n => n.Id));
            Assert.Empty(tree.ChildrenOf(s.Region));
        }

        [Fact]
        public void Nodes_NodesOfType_Contains_and_TryGetNode_enumerate_the_forest()
        {
            var s = new Shape();
            var tree = s.Tree();
            Assert.Equal(6, tree.Count);
            Assert.Equal(6, tree.Nodes.Count());
            Assert.Equal(3, tree.NodesOfType(TableConfigType.ChildTable).Count());
            Assert.Equal(2, tree.NodesOfType(TableConfigType.LookupTable).Count());
            Assert.True(tree.Contains(s.Region));
            Assert.True(tree.TryGetNode(s.Region, out var region));
            Assert.Equal("sample_region", region.TableLogicalName);
            Assert.False(tree.TryGetNode(Guid.NewGuid(), out _));
        }

        [Fact]
        public void FromNodesUnvalidated_computes_best_effort_depth_and_never_throws()
        {
            var root = Guid.NewGuid(); var a = Guid.NewGuid(); var missing = Guid.NewGuid();
            var tree = TestTree.RawTree(
                TestTree.Node(root, "r", TableConfigType.RootTable, null),
                TestTree.Node(a, "a", TableConfigType.LookupTable, missing));
            Assert.Equal(0, tree.Depth(root));
            Assert.Equal(0, tree.Depth(a));            // the one hop it has cannot be followed
            Assert.Null(tree.RootOf(a));
            Assert.False(tree.IsReachableFromRoot(a));
            Assert.Equal(new[] { a }, tree.ChainToRoot(a).Select(n => n.Id));
        }

        [Fact]
        public void Validator_queries_on_a_malformed_unvalidated_tree_answer_conservatively_and_never_throw()
        {
            // The validator holds an UNVALIDATED tree and must REPORT a broken shape, so the
            // queries it runs can never throw for a cycle, a missing ancestor or a parentless
            // non-root. Each answers the conservative way.
            var root = Guid.NewGuid();
            var cycA = Guid.NewGuid(); var cycB = Guid.NewGuid();        // cycA ⇄ cycB (child links)
            var gapChild = Guid.NewGuid(); var gone = Guid.NewGuid();    // gapChild → (absent) gone
            var orphan = Guid.NewGuid(); var underOrphan = Guid.NewGuid();
            var tree = TestTree.RawTree(
                TestTree.Node(root, "r", TableConfigType.RootTable, null),
                TestTree.Node(cycA, "a", TableConfigType.ChildTable, cycB, "a_b"),
                TestTree.Node(cycB, "b", TableConfigType.ChildTable, cycA, "b_a"),
                TestTree.Node(gapChild, "g", TableConfigType.ChildTable, gone, "g_gone"),
                TestTree.Node(orphan, "o", TableConfigType.LookupTable, null),
                TestTree.Node(underOrphan, "u", TableConfigType.ChildTable, orphan, "u_o"));

            Assert.Equal(ChainShape.Cycle, tree.ChainDiagnosis(cycA).Shape);
            Assert.Equal(ChainShape.MissingAncestor, tree.ChainDiagnosis(gapChild).Shape);
            Assert.Equal(gone, tree.ChainDiagnosis(gapChild).MissingParentId);
            Assert.Equal(ChainShape.OrphanNonRoot, tree.ChainDiagnosis(orphan).Shape);
            Assert.Equal(ChainShape.OrphanNonRoot, tree.ChainDiagnosis(underOrphan).Shape);

            foreach (var id in new[] { cycA, cycB, gapChild, orphan, underOrphan, Guid.NewGuid() })
            {
                Assert.False(tree.TrySingleCardinality(id));
                Assert.False(tree.IsReachableFromRoot(id));
                Assert.False(tree.IsAllChildLinksToRoot(id));
                Assert.False(tree.IsSelfOrAncestor(root, id));
            }
            Assert.True(tree.IsSelfOrAncestor(orphan, underOrphan));    // the hop that exists is seen
            Assert.True(tree.IsSelfOrAncestor(cycB, cycA));             // one hop into the cycle, then stop
            Assert.Null(tree.RootOf(cycA));
            Assert.Null(tree.RootOf(gapChild));
            Assert.Equal(new[] { orphan, underOrphan }, tree.ChainToRoot(underOrphan).Select(n => n.Id));
            Assert.True(tree.TrySingleCardinality(root));
            Assert.True(tree.IsReachableFromRoot(root));
        }
    }
}
