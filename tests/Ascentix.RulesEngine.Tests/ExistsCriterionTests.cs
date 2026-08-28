using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Covers NodeFilterEvaluator.MatchesCriterion's CriterionKind.Exists branch: LCA relate
    /// (TableConfigTree.Lca) + ancestor-instance walk (NodeRelate.AncestorInstanceId) + a
    /// count-in-range over the related collection, per-row filtered through SubFilter.
    /// Cache/config scaffolding modeled on MathExprFilteredAggregateTests.ChildSetup.
    /// </summary>
    public class ExistsCriterionTests
    {
        // order (root, depth 0)
        //   line (child, depth 1, link "line_orderid")
        //   shipment (child, depth 1, link "shipment_orderid")
        //     -> line also has a grandchild for the "deeper" case:
        //   linenote (child of line, depth 2, link "linenote_lineid")
        private static (TableConfigTree configs, Guid orderId, Guid lineId, Guid shipmentId, Guid lineNoteId)
            BuildTree()
        {
            var orderId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var shipmentId = Guid.NewGuid();
            var lineNoteId = Guid.NewGuid();

            var configs = TestTree.Tree(
                new TableConfig
                {
                    Id = orderId, TableLogicalName = "sample_order",
                    ConfigType = TableConfigType.RootTable,
                },
                new TableConfig
                {
                    Id = lineId, TableLogicalName = "sample_orderline",
                    ConfigType = TableConfigType.ChildTable, ParentTableId = orderId,
                    ChildLinkField = "line_orderid",
                },
                new TableConfig
                {
                    Id = shipmentId, TableLogicalName = "sample_shipment",
                    ConfigType = TableConfigType.ChildTable, ParentTableId = orderId,
                    ChildLinkField = "shipment_orderid",
                },
                new TableConfig
                {
                    Id = lineNoteId, TableLogicalName = "sample_linenote",
                    ConfigType = TableConfigType.ChildTable, ParentTableId = lineId,
                    ChildLinkField = "linenote_lineid",
                });
            return (configs, orderId, lineId, shipmentId, lineNoteId);
        }

        private static NodeFilterCriterion ExistsCriterion(Guid collectionNodeId, int? minCount, int? maxCount,
            NodeFilterGroup subFilter) => new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = collectionNodeId,
                MinCount = minCount,
                MaxCount = maxCount,
                SubFilter = subFilter,
            };

        private static NodeFilterGroup StatusEqExpedited() => new NodeFilterGroup
        {
            LogicalOperator = LogicalOperator.And,
            Criteria = new List<NodeFilterCriterion>
            {
                new NodeFilterCriterion { FieldName = "statuscode", Operator = "eq", Value = "expedited" },
            },
        };

        private static NodeFilterEvaluator Evaluator(QueryResultCache cache, TableConfigTree configs) =>
            new NodeFilterEvaluator(new FieldValueResolver(), null, cache, configs);

        // ── Sibling case: Exists on line, targeting shipment (LCA = order) ─────

        [Fact]
        public void Line_whose_order_has_an_expedited_shipment_matches()
        {
            var (configs, orderId, lineId, shipmentId, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };
            var shipment = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["shipment_orderid"] = new EntityReference("sample_order", order.Id),
                ["statuscode"] = "expedited",
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });
            cache.Store(shipmentId, new List<Entity> { shipment });

            var criterion = ExistsCriterion(shipmentId, minCount: 1, maxCount: null, subFilter: StatusEqExpedited());
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId));
        }

        [Fact]
        public void MinCount_one_with_no_shipments_does_not_match()
        {
            var (configs, orderId, lineId, shipmentId, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });
            cache.Store(shipmentId, new List<Entity>()); // no shipments at all

            var criterion = ExistsCriterion(shipmentId, minCount: 1, maxCount: null, subFilter: StatusEqExpedited());
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId));
        }

        [Fact]
        public void MaxCount_zero_not_exists_inverts_the_match()
        {
            var (configs, orderId, lineId, shipmentId, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };
            var shipment = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["shipment_orderid"] = new EntityReference("sample_order", order.Id),
                ["statuscode"] = "expedited",
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });
            cache.Store(shipmentId, new List<Entity> { shipment });

            // not-exists: MaxCount 0 means "no matching shipment allowed"
            var criterion = ExistsCriterion(shipmentId, minCount: null, maxCount: 0, subFilter: StatusEqExpedited());
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            // An expedited shipment exists -> MaxCount 0 is violated -> no match (inverted from the first test).
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId));

            // Now with no matching shipment, MaxCount 0 is satisfied -> match.
            cache.Store(shipmentId, new List<Entity>());
            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId));
        }

        // ── Unbounded (no MinCount/MaxCount) means "at least one", not always-true ──

        [Fact]
        public void Unbounded_MinMax_with_zero_matching_rows_does_not_match()
        {
            var (configs, orderId, lineId, shipmentId, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });
            cache.Store(shipmentId, new List<Entity>()); // no shipments at all

            var criterion = ExistsCriterion(shipmentId, minCount: null, maxCount: null, subFilter: StatusEqExpedited());
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId));
        }

        [Fact]
        public void Unbounded_MinMax_with_one_matching_row_matches()
        {
            var (configs, orderId, lineId, shipmentId, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };
            var shipment = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["shipment_orderid"] = new EntityReference("sample_order", order.Id),
                ["statuscode"] = "expedited",
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });
            cache.Store(shipmentId, new List<Entity> { shipment });

            var criterion = ExistsCriterion(shipmentId, minCount: null, maxCount: null, subFilter: StatusEqExpedited());
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId));
        }

        [Fact]
        public void SubFilter_that_excludes_all_rows_does_not_match()
        {
            var (configs, orderId, lineId, shipmentId, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };
            var shipment = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["shipment_orderid"] = new EntityReference("sample_order", order.Id),
                ["statuscode"] = "standard", // does not match the "expedited" sub-filter
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });
            cache.Store(shipmentId, new List<Entity> { shipment });

            var criterion = ExistsCriterion(shipmentId, minCount: 1, maxCount: null, subFilter: StatusEqExpedited());
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId));
        }

        // ── Direct-child case: Exists on order (root), targeting line ──────────

        [Fact]
        public void Direct_child_exists_on_root_targeting_its_own_child_collection()
        {
            var (configs, orderId, lineId, _, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var matchingLine = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
                ["statuscode"] = "expedited",
            };
            var otherOrder = new Entity("sample_order", Guid.NewGuid());
            var nonMatchingLine = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", otherOrder.Id),
                ["statuscode"] = "standard", // belongs to otherOrder but fails the sub-filter
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order, otherOrder });
            cache.Store(lineId, new List<Entity> { matchingLine, nonMatchingLine });

            var criterion = ExistsCriterion(lineId, minCount: 1, maxCount: null, subFilter: StatusEqExpedited());
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { order }, orderId));
            Assert.False(eval.EvaluateFilterGroup(group, new List<Entity> { otherOrder }, orderId));
        }

        // ── Deeper case: Exists on linenote (grandchild of order via line), ────
        // ── targeting shipment (LCA = order, two hops up on the linenote side) ─

        [Fact]
        public void Deeper_grandchild_exists_walks_up_through_a_cached_intermediate_parent()
        {
            var (configs, orderId, lineId, shipmentId, lineNoteId) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };
            var lineNote = new Entity("sample_linenote", Guid.NewGuid())
            {
                ["linenote_lineid"] = new EntityReference("sample_orderline", line.Id),
            };
            var shipment = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["shipment_orderid"] = new EntityReference("sample_order", order.Id),
                ["statuscode"] = "expedited",
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line }); // intermediate parent, fetched from cache mid-walk
            cache.Store(lineNoteId, new List<Entity> { lineNote });
            cache.Store(shipmentId, new List<Entity> { shipment });

            var criterion = ExistsCriterion(shipmentId, minCount: 1, maxCount: null, subFilter: StatusEqExpedited());
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { lineNote }, lineNoteId));
        }

        // ── Boundary matrix: MinCount/MaxCount combinations against the actual ──
        // ── count of matching related rows. This arithmetic is exactly where ────
        // ── off-by-one errors live, so every min/max pairing is exercised. ──────

        private static bool EvaluateExistsBoundary(int? minCount, int? maxCount, int rowCount)
        {
            var (configs, orderId, lineId, shipmentId, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };

            var shipments = new List<Entity>();
            for (var i = 0; i < rowCount; i++)
            {
                shipments.Add(new Entity("sample_shipment", Guid.NewGuid())
                {
                    ["shipment_orderid"] = new EntityReference("sample_order", order.Id),
                    ["statuscode"] = "expedited",
                });
            }

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });
            cache.Store(shipmentId, shipments);

            var criterion = ExistsCriterion(shipmentId, minCount, maxCount, subFilter: StatusEqExpedited());
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            return eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId);
        }

        [Theory]
        // Characterization: MinCount=0 is vacuously true. A plausible author intent for
        // "none" that actually means "always match". Pinned, not endorsed.
        [InlineData(0, null, 0, true)]
        [InlineData(2, 3, 1, false)]
        [InlineData(2, 3, 2, true)]
        [InlineData(2, 3, 3, true)]
        [InlineData(2, 3, 4, false)]
        [InlineData(3, 3, 2, false)]
        [InlineData(3, 3, 3, true)]
        [InlineData(null, 2, 2, true)]
        [InlineData(null, 2, 3, false)]
        public void EvaluateExists_boundary_matrix(int? minCount, int? maxCount, int rowCount, bool expected)
        {
            Assert.Equal(expected, EvaluateExistsBoundary(minCount, maxCount, rowCount));
        }

        // ── SubFilter == null short-circuit: counts every related row, unfiltered ──

        [Fact]
        public void Exists_without_a_sub_filter_counts_every_related_row()
        {
            // Reachable via the record path: ConditionGroupMapper leaves SubFilter null when no
            // owning group is wired. (The JSON path can't reach it - AggregateFilterParser throws
            // on a missing 'sub'.)
            var (configs, orderId, lineId, shipmentId, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };
            var shipmentA = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["shipment_orderid"] = new EntityReference("sample_order", order.Id),
                ["statuscode"] = "standard",
            };
            var shipmentB = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["shipment_orderid"] = new EntityReference("sample_order", order.Id),
                // no statuscode at all - would fail the "expedited" sub-filter used elsewhere in this file
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });
            cache.Store(shipmentId, new List<Entity> { shipmentA, shipmentB });

            // No sub-filter: both shipments should count regardless of statuscode.
            var criterion = ExistsCriterion(shipmentId, minCount: 2, maxCount: null, subFilter: null);
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            Assert.True(eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId));
        }

        // ── An unrelatable collection row can't be walked to the shared ─────────
        // ── ancestor, so it silently doesn't count. ──────────────────────────────

        [Fact]
        public void Unrelatable_row_counts_as_zero_so_not_exists_is_satisfied()
        {
            // When AncestorInstanceId returns null (missing parent lookup,
            // unpopulated ChildLinkField, or the intermediate parent absent from the cache),
            // count stays 0. So min=1 silently does not match and max=0 silently DOES.
            // "We can't prove it exists" is not "it doesn't exist" - arguably wrong, but
            // changing it is out of scope. Pinned deliberately; revisit if a real rule hits it.
            var (configs, orderId, lineId, shipmentId, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };
            // Unrelatable: no "shipment_orderid" reference at all, so NodeRelate.AncestorInstanceId
            // can't walk this row up to the order ancestor (ChildLinkField value is absent).
            var unrelatableShipment = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["statuscode"] = "expedited",
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });
            cache.Store(shipmentId, new List<Entity> { unrelatableShipment });

            var eval = Evaluator(cache, configs);

            var maxZeroCriterion = ExistsCriterion(shipmentId, minCount: null, maxCount: 0, subFilter: StatusEqExpedited());
            var maxZeroGroup = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { maxZeroCriterion } };
            Assert.True(eval.EvaluateFilterGroup(maxZeroGroup, new List<Entity> { line }, lineId));

            var minOneCriterion = ExistsCriterion(shipmentId, minCount: 1, maxCount: null, subFilter: StatusEqExpedited());
            var minOneGroup = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { minOneCriterion } };
            Assert.False(eval.EvaluateFilterGroup(minOneGroup, new List<Entity> { line }, lineId));
        }

        // ── Guard: CollectionNodeId is nullable on the model. ConditionGroupMapper sets it ──
        // ── from a nullable lookup (`...?.Id`) and StructuralChecks only advises, so a rule ──
        // ── saved without a collection node can reach evaluation. Must fail with an ─────────
        // ── actionable config error, not a bare CLR InvalidOperationException. ──────────────

        [Fact]
        public void Exists_without_a_collection_node_throws_a_config_error_not_a_CLR_error()
        {
            var (configs, orderId, lineId, _, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });

            var criterion = new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = null, // saved without a collection node
                MinCount = 1,
                MaxCount = null,
                SubFilter = StatusEqExpedited(),
            };
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId));
            Assert.Contains("collection", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        // ── Guard: nested EXISTS is a non-goal ("the sub-filter is scalar-only"), ────────────
        // ── but AggregateFilterParser accepts it, RuleLoader BFS-descends it, and ───────────
        // ── EvaluateExists recurses into EvaluateFilterGroup incidentally. Must be rejected ──
        // ── at evaluation time rather than silently recursing. ──────────────────────────────

        [Fact]
        public void Nested_exists_inside_a_sub_filter_throws()
        {
            var (configs, orderId, lineId, shipmentId, _) = BuildTree();
            var order = new Entity("sample_order", Guid.NewGuid());
            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["line_orderid"] = new EntityReference("sample_order", order.Id),
            };
            var shipment = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["shipment_orderid"] = new EntityReference("sample_order", order.Id),
            };

            var cache = new QueryResultCache();
            cache.Store(orderId, new List<Entity> { order });
            cache.Store(lineId, new List<Entity> { line });
            cache.Store(shipmentId, new List<Entity> { shipment });

            // A sub-filter that itself contains an Exists criterion - nested EXISTS, non-goal.
            var nestedSubFilter = new NodeFilterGroup
            {
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    ExistsCriterion(shipmentId, minCount: 1, maxCount: null, subFilter: StatusEqExpedited()),
                },
            };

            var criterion = ExistsCriterion(shipmentId, minCount: 1, maxCount: null, subFilter: nestedSubFilter);
            var group = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { criterion } };

            var eval = Evaluator(cache, configs);
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => eval.EvaluateFilterGroup(group, new List<Entity> { line }, lineId));
            Assert.Contains("nest", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
