using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// The two halves of relating an EXISTS row to its condition row: the STRUCTURE
    /// (<see cref="TableConfigTree.Lca"/>, the lowest common ancestor of two config-tree nodes,
    /// and <see cref="TableConfigTree.HopsBetween"/>, the hop sequence from a node up to an
    /// ancestor) and the DATA walk (<see cref="NodeRelate.AncestorInstanceId"/>: following each
    /// hop's ChildLinkField through the cached rows to the ancestor's instance id). Every EXISTS
    /// evaluation depends on this file.
    ///
    /// The three return-null paths in AncestorInstanceId (hop with no ChildLinkField, null parent
    /// ref, intermediate parent ROW absent from a fetched set) all mean the same thing: an
    /// unrelatable row counts as zero, so "not exists" is satisfied. Those are pinned here as
    /// happy-path (non-throwing) tests, matching ExistsCriterionTests.
    /// Unrelatable_row_counts_as_zero_so_not_exists_is_satisfied. An intermediate
    /// parent ENTRY that was never fetched is not one of them: that is a planning fault and
    /// the result cache's loud read throws.
    /// </summary>
    public class NodeRelateTests
    {
        // ─── Happy path: Lca ────────────────────────────────────────────────────

        [Fact]
        public void Lca_of_a_node_with_itself_is_that_node()
        {
            var root = TestTree.Node(Guid.NewGuid(), "sample_order", TableConfigType.RootTable, null);
            var tree = TestTree.Tree(root);

            Assert.Equal(root.Id, tree.Lca(root.Id, root.Id));
        }

        [Fact]
        public void Lca_of_a_parent_and_its_child_is_the_parent()
        {
            var root = TestTree.Node(Guid.NewGuid(), "sample_order", TableConfigType.RootTable, null);
            var child = TestTree.Node(Guid.NewGuid(), "sample_orderline", TableConfigType.ChildTable, root.Id, "line_orderid");
            var tree = TestTree.Tree(root, child);

            Assert.Equal(root.Id, tree.Lca(root.Id, child.Id));
        }

        [Fact]
        public void Lca_of_two_siblings_is_their_shared_root()
        {
            var root = TestTree.Node(Guid.NewGuid(), "sample_order", TableConfigType.RootTable, null);
            var line = TestTree.Node(Guid.NewGuid(), "sample_orderline", TableConfigType.ChildTable, root.Id, "line_orderid");
            var shipment = TestTree.Node(Guid.NewGuid(), "sample_shipment", TableConfigType.ChildTable, root.Id, "shipment_orderid");
            var tree = TestTree.Tree(root, line, shipment);

            Assert.Equal(root.Id, tree.Lca(line.Id, shipment.Id));
        }

        // ─── Happy path: HopsBetween (the structure the data walk follows) ───────

        [Fact]
        public void HopsBetween_lists_each_hop_nearest_first_with_its_child_link_and_parent()
        {
            var orderId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var lineNoteId = Guid.NewGuid();
            var tree = TestTree.Tree(
                TestTree.Node(orderId, "sample_order", TableConfigType.RootTable, null),
                TestTree.Node(lineId, "sample_orderline", TableConfigType.ChildTable, orderId, "line_orderid"),
                TestTree.Node(lineNoteId, "sample_linenote", TableConfigType.ChildTable, lineId, "linenote_lineid"));

            var hops = tree.HopsBetween(lineNoteId, orderId);

            Assert.Equal(2, hops.Count);
            Assert.Equal(lineNoteId, hops[0].Node.Id);
            Assert.Equal("linenote_lineid", hops[0].ChildLinkField);
            Assert.Equal(lineId, hops[0].ParentNodeId);
            Assert.Equal(lineId, hops[1].Node.Id);
            Assert.Equal("line_orderid", hops[1].ChildLinkField);
            Assert.Equal(orderId, hops[1].ParentNodeId);
            Assert.Empty(tree.HopsBetween(orderId, orderId));
        }

        // ─── Happy path: AncestorInstanceId ─────────────────────────────────────

        [Fact]
        public void AncestorInstance_of_a_row_with_itself_as_the_target_is_the_row_id()
        {
            var root = TestTree.Node(Guid.NewGuid(), "sample_order", TableConfigType.RootTable, null);
            var tree = TestTree.Tree(root);
            var record = TestTree.Row("sample_order", Guid.NewGuid());

            var result = NodeRelate.AncestorInstanceId(record, root.Id, root.Id, TestTree.Cache(), tree);

            Assert.Equal(record.Id, result);
        }

        [Fact]
        public void AncestorInstance_walks_two_hops_through_a_cached_intermediate_parent()
        {
            var orderId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var lineNoteId = Guid.NewGuid();
            var root = TestTree.Node(orderId, "sample_order", TableConfigType.RootTable, null);
            var line = TestTree.Node(lineId, "sample_orderline", TableConfigType.ChildTable, orderId, "line_orderid");
            var lineNote = TestTree.Node(lineNoteId, "sample_linenote", TableConfigType.ChildTable, lineId, "linenote_lineid");
            var tree = TestTree.Tree(root, line, lineNote);

            var orderRow = TestTree.Row("sample_order", Guid.NewGuid());
            var lineRow = TestTree.Row("sample_orderline", Guid.NewGuid(), ("line_orderid", new EntityReference("sample_order", orderRow.Id)));
            var lineNoteRow = TestTree.Row("sample_linenote", Guid.NewGuid(), ("linenote_lineid", new EntityReference("sample_orderline", lineRow.Id)));
            var cache = TestTree.Cache((lineId, new List<Entity> { lineRow }));

            var result = NodeRelate.AncestorInstanceId(lineNoteRow, lineNoteId, orderId, cache, tree);

            Assert.Equal(orderRow.Id, result);
        }

        [Fact]
        public void AncestorInstance_to_the_immediate_parent_reads_the_link_without_touching_the_cache()
        {
            // The last hop's parent IS the target: the answer is the row's own reference, so the
            // parent entry is never read (it need not even have been fetched for this walk).
            var orderId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var lineNoteId = Guid.NewGuid();
            var tree = TestTree.Tree(
                TestTree.Node(orderId, "sample_order", TableConfigType.RootTable, null),
                TestTree.Node(lineId, "sample_orderline", TableConfigType.ChildTable, orderId, "line_orderid"),
                TestTree.Node(lineNoteId, "sample_linenote", TableConfigType.ChildTable, lineId, "linenote_lineid"));

            var lineRowId = Guid.NewGuid();
            var lineNoteRow = TestTree.Row("sample_linenote", Guid.NewGuid(), ("linenote_lineid", new EntityReference("sample_orderline", lineRowId)));

            var result = NodeRelate.AncestorInstanceId(lineNoteRow, lineNoteId, lineId, TestTree.Cache(), tree);

            Assert.Equal(lineRowId, result);
        }

        [Fact]
        public void AncestorInstance_returns_null_when_the_row_has_no_parent_reference()
        {
            var orderId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var root = TestTree.Node(orderId, "sample_order", TableConfigType.RootTable, null);
            var line = TestTree.Node(lineId, "sample_orderline", TableConfigType.ChildTable, orderId, "line_orderid");
            var tree = TestTree.Tree(root, line);

            var lineRow = TestTree.Row("sample_orderline", Guid.NewGuid()); // no "line_orderid" attribute set

            var result = NodeRelate.AncestorInstanceId(lineRow, lineId, orderId, TestTree.Cache(), tree);

            Assert.Null(result);
        }

        // The mid-walk parent lookup distinguishes two absences that must never be conflated:
        // the parent ROW missing from a fetched set (legitimate: the row's ancestor fell
        // outside the traversal, and it counts as zero) versus the parent ENTRY never fetched
        // (a planning fault: the engine would otherwise relate nothing and count zero with
        // nothing logged).

        [Fact]
        public void AncestorInstance_returns_null_when_the_intermediate_parent_row_is_absent_from_a_fetched_set()
        {
            var orderId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var lineNoteId = Guid.NewGuid();
            var root = TestTree.Node(orderId, "sample_order", TableConfigType.RootTable, null);
            var line = TestTree.Node(lineId, "sample_orderline", TableConfigType.ChildTable, orderId, "line_orderid");
            var lineNote = TestTree.Node(lineNoteId, "sample_linenote", TableConfigType.ChildTable, lineId, "linenote_lineid");
            var tree = TestTree.Tree(root, line, lineNote);

            var lineNoteRow = TestTree.Row("sample_linenote", Guid.NewGuid(), ("linenote_lineid", new EntityReference("sample_orderline", Guid.NewGuid())));
            // The line node WAS fetched. It just does not contain the row this note points at.
            var otherLine = TestTree.Row("sample_orderline", Guid.NewGuid());
            var cache = TestTree.Cache((lineId, new List<Entity> { otherLine }));

            var result = NodeRelate.AncestorInstanceId(lineNoteRow, lineNoteId, orderId, cache, tree);

            Assert.Null(result);
        }

        [Fact]
        public void AncestorInstance_throws_a_planning_fault_when_the_intermediate_parent_was_never_fetched()
        {
            var orderId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var lineNoteId = Guid.NewGuid();
            var root = TestTree.Node(orderId, "sample_order", TableConfigType.RootTable, null);
            var line = TestTree.Node(lineId, "sample_orderline", TableConfigType.ChildTable, orderId, "line_orderid");
            var lineNote = TestTree.Node(lineNoteId, "sample_linenote", TableConfigType.ChildTable, lineId, "linenote_lineid");
            var tree = TestTree.Tree(root, line, lineNote);

            var lineNoteRow = TestTree.Row("sample_linenote", Guid.NewGuid(), ("linenote_lineid", new EntityReference("sample_orderline", Guid.NewGuid())));
            // No cache entry for lineId at all: no query was ever executed for the line node.

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => NodeRelate.AncestorInstanceId(lineNoteRow, lineNoteId, orderId, TestTree.Cache(), tree));
            Assert.Contains(lineId.ToString(), ex.Message);
            Assert.Contains("planning fault", ex.Message);
        }

        [Fact]
        public void AncestorInstance_returns_null_when_the_current_node_has_no_child_link_field()
        {
            // ChildLinkField unset (a misconfigured node reached mid-walk) returns null rather
            // than dereferencing an empty field name.
            var orderId = Guid.NewGuid();
            var misconfiguredId = Guid.NewGuid();
            var root = TestTree.Node(orderId, "sample_order", TableConfigType.RootTable, null);
            var misconfigured = TestTree.Node(misconfiguredId, "sample_orderline", TableConfigType.ChildTable, orderId, childLinkField: null);
            var tree = TestTree.Tree(root, misconfigured);

            var row = TestTree.Row("sample_orderline", Guid.NewGuid());

            var result = NodeRelate.AncestorInstanceId(row, misconfiguredId, orderId, TestTree.Cache(), tree);

            Assert.Null(result);
        }

        // ─── Error paths ────────────────────────────────────────────────────────

        [Fact]
        public void Lca_with_a_node_missing_from_the_config_tree_throws_a_config_error()
        {
            var known = TestTree.Node(Guid.NewGuid(), "sample_order", TableConfigType.RootTable, null);
            var tree = TestTree.Tree(known);

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => tree.Lca(known.Id, Guid.NewGuid()));
            Assert.Contains("config", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void Lca_of_two_disjoint_roots_throws_rather_than_dereferencing_a_null_parent()
        {
            var rootA = TestTree.Node(Guid.NewGuid(), "sample_order", TableConfigType.RootTable, null);
            var rootB = TestTree.Node(Guid.NewGuid(), "sample_other_root", TableConfigType.RootTable, null);
            var tree = TestTree.Tree(rootA, rootB);

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => tree.Lca(rootA.Id, rootB.Id));
            Assert.Contains("common ancestor", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void Lca_on_a_cyclic_parent_chain_throws_instead_of_returning_a_wrong_node()
        {
            // Two same-depth nodes whose ParentTableId point at each other: the walk-up
            // loop can never reach a.Id == b.Id and must not silently fall through. The loader
            // refuses this shape (the tree validates at construction), so it is only reachable
            // on an unvalidated tree, where the walk carries its own seen-set.
            var aId = Guid.NewGuid();
            var bId = Guid.NewGuid();
            var a = TestTree.Node(aId, "sample_a", TableConfigType.ChildTable, bId, "a_bid");
            var b = TestTree.Node(bId, "sample_b", TableConfigType.ChildTable, aId, "b_aid");
            var tree = TestTree.RawTree(a, b);

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => tree.Lca(a.Id, b.Id));
            Assert.Contains("cycle", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void AncestorInstance_on_a_cyclic_parent_chain_throws_instead_of_returning_a_wrong_id()
        {
            // rowA <-> rowB reference each other via reciprocal ChildLinkFields, and the
            // target ancestor node is never reached: the structural walk must not silently fall
            // through and return whichever row it happened to be standing on.
            var aId = Guid.NewGuid();
            var bId = Guid.NewGuid();
            var unreachableId = Guid.NewGuid();
            var a = TestTree.Node(aId, "sample_a", TableConfigType.ChildTable, bId, "a_bid");
            var b = TestTree.Node(bId, "sample_b", TableConfigType.ChildTable, aId, "b_aid");
            var tree = TestTree.RawTree(a, b);

            var rowA = TestTree.Row("sample_a", Guid.NewGuid());
            var rowB = TestTree.Row("sample_b", Guid.NewGuid());
            rowA["a_bid"] = new EntityReference("sample_b", rowB.Id);
            rowB["b_aid"] = new EntityReference("sample_a", rowA.Id);
            var cache = TestTree.Cache((aId, new List<Entity> { rowA }), (bId, new List<Entity> { rowB }));

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => NodeRelate.AncestorInstanceId(rowA, aId, unreachableId, cache, tree));
            Assert.Contains("cycle", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void AncestorInstance_to_a_node_off_the_parent_chain_is_a_structural_error()
        {
            // A sibling is not an ancestor. The tree owns that verdict (HopsBetween throws the
            // "no common ancestor" error). The data walk never starts, so it cannot return a
            // misleading null from a row that simply ran out of parents.
            var orderId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var shipmentId = Guid.NewGuid();
            var tree = TestTree.Tree(
                TestTree.Node(orderId, "sample_order", TableConfigType.RootTable, null),
                TestTree.Node(lineId, "sample_orderline", TableConfigType.ChildTable, orderId, "line_orderid"),
                TestTree.Node(shipmentId, "sample_shipment", TableConfigType.ChildTable, orderId, "shipment_orderid"));
            var lineRow = TestTree.Row("sample_orderline", Guid.NewGuid(), ("line_orderid", new EntityReference("sample_order", Guid.NewGuid())));

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => NodeRelate.AncestorInstanceId(lineRow, lineId, shipmentId, TestTree.Cache(), tree));
            Assert.Contains("common ancestor", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
