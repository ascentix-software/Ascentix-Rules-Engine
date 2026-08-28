using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class FieldMappingReferencesTests
    {
        [Fact]
        public void Node_source_yields_its_node_and_no_root_columns()
        {
            var id = Guid.NewGuid();
            var e = new FieldMappingEntry { Source = "node", Node = id, Column = "x" };
            Assert.Equal(new[] { id }, FieldMappingReferences.NodeIds(e).ToArray());
            Assert.Empty(FieldMappingReferences.RootColumns(e));
        }

        [Fact]
        public void Ref_source_yields_its_node_and_no_root_columns()
        {
            var id = Guid.NewGuid();
            var e = new FieldMappingEntry { Source = "ref", Node = id };
            Assert.Equal(new[] { id }, FieldMappingReferences.NodeIds(e).ToArray());
            Assert.Empty(FieldMappingReferences.RootColumns(e));
        }

        [Fact]
        public void Root_source_yields_its_column()
        {
            var e = new FieldMappingEntry { Source = "root", Column = "name" };
            Assert.Empty(FieldMappingReferences.NodeIds(e));
            Assert.Equal(new[] { "name" }, FieldMappingReferences.RootColumns(e).ToArray());
        }

        [Fact]
        public void Template_yields_token_nodes_and_root_columns()
        {
            var id = Guid.NewGuid();
            var e = new FieldMappingEntry { Source = "template",
                Template = $"Hi {{root.name}}, {{node:{id}.fullname}} and {{root.city}}" };
            Assert.Equal(new[] { id }, FieldMappingReferences.NodeIds(e).ToArray());
            Assert.Equal(new[] { "name", "city" }, FieldMappingReferences.RootColumns(e).ToArray());
        }

        [Fact]
        public void Dateexpr_yields_anchor_node_or_root_anchor_column()
        {
            var id = Guid.NewGuid();
            var onNode = new FieldMappingEntry { Source = "dateexpr", AnchorKind = "field", AnchorNode = id, AnchorColumn = "createdon" };
            Assert.Equal(new[] { id }, FieldMappingReferences.NodeIds(onNode).ToArray());
            Assert.Empty(FieldMappingReferences.RootColumns(onNode));

            var onRoot = new FieldMappingEntry { Source = "dateexpr", AnchorKind = "field", AnchorColumn = "createdon" };
            Assert.Empty(FieldMappingReferences.NodeIds(onRoot));
            Assert.Equal(new[] { "createdon" }, FieldMappingReferences.RootColumns(onRoot).ToArray());

            var now = new FieldMappingEntry { Source = "dateexpr", AnchorKind = "now" };
            Assert.Empty(FieldMappingReferences.NodeIds(now));
            Assert.Empty(FieldMappingReferences.RootColumns(now));
        }

        [Fact]
        public void Literal_yields_nothing()
        {
            var e = new FieldMappingEntry { Source = "literal", Value = "x" };
            Assert.Empty(FieldMappingReferences.NodeIds(e));
            Assert.Empty(FieldMappingReferences.RootColumns(e));
        }

        [Fact]
        public void Mathexpr_reports_node_ids_and_root_columns()
        {
            var nodeId = Guid.NewGuid();
            var entry = new FieldMappingEntry
            {
                Target = "sample_lineamount", Source = "mathexpr",
                Expression = $"{{root.sample_quantity}} * {{node:{nodeId}.price}}",
            };
            Assert.Equal(new[] { nodeId }, FieldMappingReferences.NodeIds(entry).ToArray());
            Assert.Equal(new[] { "sample_quantity" }, FieldMappingReferences.RootColumns(entry).ToArray());
        }

        [Fact]
        public void Mathexpr_aggregate_filter_reports_comparison_value_node_ids()
        {
            var nodeId = Guid.NewGuid();
            var comparisonNodeId = Guid.NewGuid();
            var nestedComparisonNodeId = Guid.NewGuid();
            var entry = new FieldMappingEntry
            {
                Target = "sample_ordertotal", Source = "mathexpr",
                Expression = $"sum(node:{nodeId}.lineamount filter:f1)",
                Filters = new Dictionary<string, NodeFilterGroup>
                {
                    ["f1"] = new NodeFilterGroup
                    {
                        Criteria = new List<NodeFilterCriterion>
                        {
                            new NodeFilterCriterion
                            {
                                FieldName = "status",
                                Operator = "eq",
                                ValueSource = ComparisonValueSource.FieldReference,
                                ComparisonValueNodeId = comparisonNodeId,
                                ComparisonValueColumn = "status",
                            },
                        },
                        ChildGroups = new List<NodeFilterGroup>
                        {
                            new NodeFilterGroup
                            {
                                Criteria = new List<NodeFilterCriterion>
                                {
                                    new NodeFilterCriterion
                                    {
                                        FieldName = "amount",
                                        Operator = "gt",
                                        ValueSource = ComparisonValueSource.FieldReference,
                                        ComparisonValueNodeId = nestedComparisonNodeId,
                                        ComparisonValueColumn = "threshold",
                                    },
                                },
                            },
                        },
                    },
                },
            };

            var ids = FieldMappingReferences.NodeIds(entry).ToArray();
            Assert.Contains(nodeId, ids);
            Assert.Contains(comparisonNodeId, ids);
            Assert.Contains(nestedComparisonNodeId, ids);
        }

        [Fact]
        public void Mathexpr_aggregate_filter_exists_criterion_reports_collection_and_subfilter_node_ids()
        {
            var nodeId = Guid.NewGuid();
            var collectionNodeId = Guid.NewGuid();
            var subFilterComparisonNodeId = Guid.NewGuid();
            var entry = new FieldMappingEntry
            {
                Target = "sample_ordertotal", Source = "mathexpr",
                Expression = $"sum(node:{nodeId}.lineamount filter:f1)",
                Filters = new Dictionary<string, NodeFilterGroup>
                {
                    ["f1"] = new NodeFilterGroup
                    {
                        Criteria = new List<NodeFilterCriterion>
                        {
                            new NodeFilterCriterion
                            {
                                Kind = CriterionKind.Exists,
                                CollectionNodeId = collectionNodeId,
                                MinCount = 1,
                                SubFilter = new NodeFilterGroup
                                {
                                    Criteria = new List<NodeFilterCriterion>
                                    {
                                        new NodeFilterCriterion
                                        {
                                            FieldName = "status",
                                            Operator = "eq",
                                            ValueSource = ComparisonValueSource.FieldReference,
                                            ComparisonValueNodeId = subFilterComparisonNodeId,
                                            ComparisonValueColumn = "status",
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            };

            var ids = FieldMappingReferences.NodeIds(entry).ToArray();
            Assert.Contains(nodeId, ids);
            Assert.Contains(collectionNodeId, ids);
            Assert.Contains(subFilterComparisonNodeId, ids);
        }

        [Fact]
        public void FilterCriterionNodeIds_yields_exists_collection_and_subfilter_value_nodes()
        {
            // Exercises the shared recursive walk directly, as the runner's condition-filter
            // seeding (RulesEngineRunner) calls it for an Exists criterion's SubFilter.
            var collectionNodeId = Guid.NewGuid();
            var subFilterComparisonNodeId = Guid.NewGuid();
            var group = new NodeFilterGroup
            {
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion
                    {
                        Kind = CriterionKind.Exists,
                        CollectionNodeId = collectionNodeId,
                        MinCount = 1,
                        SubFilter = new NodeFilterGroup
                        {
                            Criteria = new List<NodeFilterCriterion>
                            {
                                new NodeFilterCriterion
                                {
                                    FieldName = "status",
                                    Operator = "eq",
                                    ValueSource = ComparisonValueSource.FieldReference,
                                    ComparisonValueNodeId = subFilterComparisonNodeId,
                                    ComparisonValueColumn = "status",
                                },
                            },
                        },
                    },
                },
            };

            var ids = FieldMappingReferences.FilterCriterionNodeIds(group).ToArray();
            Assert.Contains(collectionNodeId, ids);
            Assert.Contains(subFilterComparisonNodeId, ids);
        }

        [Fact]
        public void Mathexpr_aggregate_reports_its_child_node_id()
        {
            var nodeId = Guid.NewGuid();
            var entry = new FieldMappingEntry
            {
                Target = "sample_ordertotal", Source = "mathexpr",
                Expression = $"sum(node:{nodeId}.lineamount)",
            };
            Assert.Equal(new[] { nodeId }, FieldMappingReferences.NodeIds(entry).ToArray());
            // aggregate columns are child-node columns (fetched wholesale by traversal), not root columns
            Assert.Empty(FieldMappingReferences.RootColumns(entry));
        }
    }
}
