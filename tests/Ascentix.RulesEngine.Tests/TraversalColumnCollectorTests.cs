using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using LogicalOperator = Ascentix.RulesEngine.Core.Models.LogicalOperator;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>Column pruning: precise collection from structured sources only,
    /// unpruneable nodes left at full width, and the executor emitting attribute lists.</summary>
    public class TraversalColumnCollectorTests
    {
        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid LineId = Guid.NewGuid();
        private static readonly Guid ProductId = Guid.NewGuid();

        private static TableConfigTree Configs() => TestTree.Tree(
            new TableConfig { Id = RootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
            new TableConfig { Id = LineId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_orderid", ParentTableId = RootId },
            new TableConfig { Id = ProductId, TableLogicalName = "sample_product", ConfigType = TableConfigType.LookupTable, LookupColumnLogicalName = "sample_productid", LookupTargetIdAttribute = "sample_productid", ParentTableId = LineId }
        );

        private static List<ConditionGroup> Groups(params RuleCondition[] conditions) =>
            new List<ConditionGroup> { new ConditionGroup { Id = Guid.NewGuid(), Conditions = conditions.ToList() } };

        [Fact]
        public void Collects_condition_filter_criteria_and_structural_columns()
        {
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = LineId,
                ConditionType = ConditionType.RowCount,
                MinExpectedRows = 1,
            };
            cond.SearchCriteriaGroups.Add(new SearchCriteriaGroup
            {
                LogicalOperator = LogicalOperator.And,
                Criteria = { new SearchCriterion { FieldName = "sample_linestatus", Operator = "eq", Value = "1" } },
            });
            var groups = Groups(cond);
            groups[0].NodeFilterGroups.Add(new NodeFilterGroup
            {
                TableConfigNodeId = LineId,
                RuleConditionId = cond.Id,
                LogicalOperator = LogicalOperator.And,
                Criteria = { new NodeFilterCriterion { FieldName = "sample_lineamount", Operator = "gt", Value = "0" } },
            });

            var cols = TraversalColumnCollector.Collect(Configs(), groups, null);

            Assert.True(cols.ContainsKey(LineId));
            var line = cols[LineId];
            Assert.Contains("sample_linestatus", line);   // search criterion
            Assert.Contains("sample_lineamount", line);   // node-filter criterion
            Assert.Contains("sample_orderid", line);      // structural: child link
            Assert.Contains("sample_productid", line);    // structural: child lookup column
            Assert.False(cols.ContainsKey(ProductId));    // lookup nodes never pruned
            Assert.False(cols.ContainsKey(RootId));
        }

        [Fact]
        public void Field_reference_rhs_lands_on_the_referenced_node()
        {
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = LineId,
                ConditionType = ConditionType.FieldComparison,
                ComparisonColumn = "sample_lineamount",
                ComparisonOperator = ComparisonOperator.GreaterThan,
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueColumn = "sample_minamount", // same-record RHS (no value node)
            };
            var cols = TraversalColumnCollector.Collect(Configs(), Groups(cond), null);
            Assert.Contains("sample_lineamount", cols[LineId]);
            Assert.Contains("sample_minamount", cols[LineId]);
        }

        [Fact]
        public void Exists_subfilter_fields_land_on_the_collection_node()
        {
            var cond = new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = LineId, ConditionType = ConditionType.RowCount, MinExpectedRows = 1 };
            var groups = Groups(cond);
            groups[0].NodeFilterGroups.Add(new NodeFilterGroup
            {
                TableConfigNodeId = LineId,
                RuleConditionId = cond.Id,
                LogicalOperator = LogicalOperator.And,
                Criteria =
                {
                    new NodeFilterCriterion
                    {
                        Kind = CriterionKind.Exists,
                        CollectionNodeId = LineId,
                        MinCount = 1,
                        SubFilter = new NodeFilterGroup
                        {
                            LogicalOperator = LogicalOperator.And,
                            Criteria = { new NodeFilterCriterion { FieldName = "sample_flag", Operator = "eq", Value = "1" } },
                        },
                    },
                },
            });
            var cols = TraversalColumnCollector.Collect(Configs(), groups, null);
            Assert.Contains("sample_flag", cols[LineId]);
        }

        [Fact]
        public void Structural_lookup_columns_come_from_the_nodes_own_children_only()
        {
            // Two lookups hang off the line node; a third hangs off the root. The line's pruned
            // width carries exactly its own children's lookup columns (the tree's reverse-edge
            // index), never a sibling subtree's, and a child lookup with no column is skipped.
            var productId = Guid.NewGuid();
            var warehouseId = Guid.NewGuid();
            var blankId = Guid.NewGuid();
            var customerId = Guid.NewGuid();
            var tree = TestTree.Tree(
                new TableConfig { Id = RootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = LineId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable, ChildLinkField = "sample_orderid", ParentTableId = RootId },
                new TableConfig { Id = productId, TableLogicalName = "sample_product", ConfigType = TableConfigType.LookupTable, LookupColumnLogicalName = "sample_productid", ParentTableId = LineId },
                new TableConfig { Id = warehouseId, TableLogicalName = "sample_warehouse", ConfigType = TableConfigType.LookupTable, LookupColumnLogicalName = "sample_warehouseid", ParentTableId = LineId },
                new TableConfig { Id = blankId, TableLogicalName = "sample_blank", ConfigType = TableConfigType.LookupTable, LookupColumnLogicalName = " ", ParentTableId = LineId },
                new TableConfig { Id = customerId, TableLogicalName = "sample_customer", ConfigType = TableConfigType.LookupTable, LookupColumnLogicalName = "sample_customerid", ParentTableId = RootId });
            var cond = new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = LineId, ConditionType = ConditionType.RowCount, MinExpectedRows = 1 };

            var cols = TraversalColumnCollector.Collect(tree, Groups(cond), null);

            var line = cols[LineId];
            Assert.Contains("sample_orderid", line);
            Assert.Contains("sample_productid", line);
            Assert.Contains("sample_warehouseid", line);
            Assert.DoesNotContain("sample_customerid", line);   // the root's lookup, not the line's
            Assert.DoesNotContain(" ", line);
            Assert.Equal(3, line.Count);
            Assert.Single(cols);                                 // lookups and the root never pruned
        }

        [Fact]
        public void Executor_emits_attribute_list_for_pruned_node()
        {
            var configs = Configs();
            var entry = new ExecutionPlanEntry
            {
                Node = configs.Node(LineId),
                ParentCacheKey = RootId.ToString(),
                Columns = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "sample_lineamount", "sample_orderid" },
            };
            var plan = new QueryExecutionPlan();
            plan.Levels.Add(new List<ExecutionPlanEntry> { entry });

            string captured = null;
            var svc = new CapturingService(xml => captured = xml);
            new QueryExecutor(svc, new QueryResultCache(), configs)
                .Execute(new Entity("sample_order", Guid.NewGuid()), plan);

            Assert.DoesNotContain("all-attributes", captured);
            Assert.Contains("<attribute name='sample_lineamount' />", captured);
            Assert.Contains("<attribute name='sample_orderid' />", captured);
        }

        private class CapturingService : IOrganizationService
        {
            private readonly Action<string> _onFetch;
            public CapturingService(Action<string> onFetch) { _onFetch = onFetch; }
            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                _onFetch(((FetchExpression)query).Query);
                return new EntityCollection();
            }
            public Guid Create(Entity entity) => throw new NotSupportedException();
            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => throw new NotSupportedException();
            public void Update(Entity entity) => throw new NotSupportedException();
            public void Delete(string entityName, Guid id) => throw new NotSupportedException();
            public OrganizationResponse Execute(OrganizationRequest request) => throw new NotSupportedException();
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
        }
    }
}
