using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Layer 3 (MetadataChecks) and Layer 2 (TraversalChecks) coverage for node-filter criteria:
    /// filter column existence/type, filter value-column existence (FieldReference RHS), the
    /// filter group's target-node ancestry relative to its owning condition, and FieldReference
    /// value-node cardinality/reachability.
    /// </summary>
    public class NodeFilterValidationTests
    {
        private class FakeFlags : IAttributeFlagsProvider
        {
            public HashSet<string> Tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public Dictionary<string, AttributeFlags> Cols = new Dictionary<string, AttributeFlags>(StringComparer.OrdinalIgnoreCase);
            public bool TableExists(string table) => Tables.Contains(table);
            public AttributeFlags GetFlags(string table, string column)
                => Cols.TryGetValue(table + "." + column, out var f) ? f : null;
        }

        private static RuleForValidation Model(
            Dictionary<Guid, TableConfig> configs,
            ConditionGroup group)
        {
            return new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                PrimaryTable = "account",
                Groups = new List<ConditionGroup> { group },
                Configs = TestTree.RawTree(configs),
                Actions = new List<RuleAction>(),
            };
        }

        // ── MetadataChecks (Layer 3) ────────────────────────────────────────

        [Fact]
        public void Unknown_filter_column_flagged()
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion { FieldName = "ghost", Operator = "eq", Value = "x" },
                },
            };
            var group = new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup> { filterGroup } };
            var flags = new FakeFlags { Tables = { "account" } };

            var issues = new MetadataChecks().Check(Model(configs, group), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_FILTER_COLUMN_NOT_FOUND");
        }

        [Fact]
        public void Ordering_operator_on_filter_text_column_flagged()
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion { FieldName = "name", Operator = "gt", Value = "x" },
                },
            };
            var group = new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup> { filterGroup } };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };

            var issues = new MetadataChecks().Check(Model(configs, group), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_FILTER_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Equality_operator_on_filter_text_column_not_flagged()
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion { FieldName = "name", Operator = "eq", Value = "x" },
                },
            };
            var group = new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup> { filterGroup } };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };

            var issues = new MetadataChecks().Check(Model(configs, group), flags).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "META_FILTER_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Null_operator_on_filter_column_not_type_checked()
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion { FieldName = "name", Operator = "null" },
                },
            };
            var group = new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup> { filterGroup } };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };

            var issues = new MetadataChecks().Check(Model(configs, group), flags).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "META_FILTER_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Unknown_filter_value_column_flagged()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [lookupId] = new TableConfig { Id = lookupId, ConfigType = TableConfigType.LookupTable, ParentTableId = rootId, TableLogicalName = "contact" },
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion
                    {
                        FieldName = "name", Operator = "eq",
                        ValueSource = ComparisonValueSource.FieldReference,
                        ComparisonValueNodeId = lookupId,
                        ComparisonValueColumn = "ghostcolumn",
                    },
                },
            };
            var group = new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup> { filterGroup } };
            var flags = new FakeFlags { Tables = { "account", "contact" } };
            flags.Cols["account.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };

            var issues = new MetadataChecks().Check(Model(configs, group), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_FILTER_VALUE_COLUMN_NOT_FOUND");
        }

        // ── TraversalChecks (Layer 2) ───────────────────────────────────────

        [Fact]
        public void Filter_targeting_sibling_node_not_ancestor_flagged()
        {
            var rootId = Guid.NewGuid();
            var child1Id = Guid.NewGuid();
            var child2Id = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [child1Id] = new TableConfig { Id = child1Id, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "contact" },
                [child2Id] = new TableConfig { Id = child2Id, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "opportunity" },
            };
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ConditionType = ConditionType.FieldComparison,
                TableConfigNodeId = child1Id,
                ComparisonColumn = "lastname",
                ComparisonOperator = ComparisonOperator.Equals,
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = child2Id, // not an ancestor of child1
                LogicalOperator = LogicalOperator.And,
                RuleConditionId = cond.Id,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion { FieldName = "name", Operator = "eq", Value = "x" },
                },
            };
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                Conditions = new List<RuleCondition> { cond },
                NodeFilterGroups = new List<NodeFilterGroup> { filterGroup },
            };
            var model = Model(configs, group);

            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_FILTER_NODE_NOT_ANCESTOR");
        }

        [Fact]
        public void Filter_targeting_owning_condition_ancestor_not_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "contact" },
            };
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ConditionType = ConditionType.FieldComparison,
                TableConfigNodeId = childId,
                ComparisonColumn = "lastname",
                ComparisonOperator = ComparisonOperator.Equals,
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId, // ancestor of childId, allowed
                LogicalOperator = LogicalOperator.And,
                RuleConditionId = cond.Id,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion { FieldName = "name", Operator = "eq", Value = "x" },
                },
            };
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                Conditions = new List<RuleCondition> { cond },
                NodeFilterGroups = new List<NodeFilterGroup> { filterGroup },
            };
            var model = Model(configs, group);

            var issues = new TraversalChecks().Check(model).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "TRAV_FILTER_NODE_NOT_ANCESTOR");
        }

        [Fact]
        public void Legacy_unowned_filter_group_skips_ancestry_check()
        {
            var rootId = Guid.NewGuid();
            var child1Id = Guid.NewGuid();
            var child2Id = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [child1Id] = new TableConfig { Id = child1Id, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "contact" },
                [child2Id] = new TableConfig { Id = child2Id, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "opportunity" },
            };
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ConditionType = ConditionType.FieldComparison,
                TableConfigNodeId = child1Id,
                ComparisonColumn = "lastname",
                ComparisonOperator = ComparisonOperator.Equals,
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = child2Id, // would fail ancestry, but legacy (unowned) is exempt
                LogicalOperator = LogicalOperator.And,
                RuleConditionId = null,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion { FieldName = "name", Operator = "eq", Value = "x" },
                },
            };
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                Conditions = new List<RuleCondition> { cond },
                NodeFilterGroups = new List<NodeFilterGroup> { filterGroup },
            };
            var model = Model(configs, group);

            var issues = new TraversalChecks().Check(model).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "TRAV_FILTER_NODE_NOT_ANCESTOR");
        }

        [Fact]
        public void Filter_value_node_many_cardinality_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "opportunity" },
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion
                    {
                        FieldName = "name", Operator = "eq",
                        ValueSource = ComparisonValueSource.FieldReference,
                        ComparisonValueNodeId = childId, // many-cardinality (ChildTable), invalid
                        ComparisonValueColumn = "name",
                    },
                },
            };
            var group = new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup> { filterGroup } };
            var model = Model(configs, group);

            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
        }

        [Fact]
        public void Filter_value_node_missing_flagged_not_found()
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
            };
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion
                    {
                        FieldName = "name", Operator = "eq",
                        ValueSource = ComparisonValueSource.FieldReference,
                        ComparisonValueNodeId = Guid.NewGuid(), // not in Configs
                        ComparisonValueColumn = "name",
                    },
                },
            };
            var group = new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup> { filterGroup } };
            var model = Model(configs, group);

            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_NODE_NOT_FOUND");
        }

        [Fact]
        public void Nested_child_filter_groups_are_checked()
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
            };
            var nested = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion>
                {
                    new NodeFilterCriterion
                    {
                        FieldName = "name", Operator = "eq",
                        ValueSource = ComparisonValueSource.FieldReference,
                        ComparisonValueNodeId = Guid.NewGuid(), // not in Configs
                        ComparisonValueColumn = "name",
                    },
                },
            };
            var outer = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                ChildGroups = new List<NodeFilterGroup> { nested },
            };
            var group = new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup> { outer } };
            var model = Model(configs, group);

            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_NODE_NOT_FOUND");
        }
    }
}
