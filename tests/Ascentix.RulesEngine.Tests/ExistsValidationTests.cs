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
    /// Server validation for the EXISTS node-filter criterion (Kind == CriterionKind.Exists):
    /// the collection node must exist and be a many-cardinality (child) collection (TraversalChecks),
    /// the sub-filter's criteria are validated against the collection's table by reusing
    /// MetadataChecks.CheckFilterCriteria, the Min/MaxCount range must be sane (MetadataChecks),
    /// and Exists criteria may only nest one level deep (StructuralChecks). Covers both the
    /// condition-filter surface (model.AllGroups() -> NodeFilterGroups) and the aggregate-filter
    /// surface (a mathexpr field-mapping entry's `filters` map).
    /// </summary>
    public class ExistsValidationTests
    {
        private class FakeFlags : IAttributeFlagsProvider
        {
            public HashSet<string> Tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public Dictionary<string, AttributeFlags> Cols = new Dictionary<string, AttributeFlags>(StringComparer.OrdinalIgnoreCase);
            public bool TableExists(string table) => Tables.Contains(table);
            public AttributeFlags GetFlags(string table, string column)
                => Cols.TryGetValue(table + "." + column, out var f) ? f : null;
        }

        // ── condition-filter model helper (mirrors NodeFilterValidationTests) ──────────────

        private static RuleForValidation ConditionModel(Dictionary<Guid, TableConfig> configs, ConditionGroup group)
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

        private static ConditionGroup GroupWithFilter(NodeFilterCriterion criterion, Guid rootId)
        {
            var filterGroup = new NodeFilterGroup
            {
                Id = Guid.NewGuid(),
                TableConfigNodeId = rootId,
                LogicalOperator = LogicalOperator.And,
                Criteria = new List<NodeFilterCriterion> { criterion },
            };
            return new ConditionGroup { Id = Guid.NewGuid(), NodeFilterGroups = new List<NodeFilterGroup> { filterGroup } };
        }

        // ── aggregate-filter model helper (mirrors AggregateFilterValidationTests) ─────────

        private static RuleForValidation AggregateModel(Dictionary<Guid, TableConfig> configs, RuleAction action, Guid rootId)
        {
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ConditionType = ConditionType.FieldComparison,
                TableConfigNodeId = rootId,
                ComparisonColumn = "name",
                ComparisonOperator = ComparisonOperator.Equals,
                ValueSource = ComparisonValueSource.Literal,
                ComparisonValue = "x",
            };
            var grp = new ConditionGroup { Id = Guid.NewGuid(), Conditions = new List<RuleCondition> { cond }, ChildGroups = new List<ConditionGroup>() };
            return new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                PrimaryTable = "sample_order",
                Groups = new List<ConditionGroup> { grp },
                Configs = TestTree.RawTree(configs),
                Actions = new List<RuleAction> { action },
            };
        }

        // ── (a) collection node not a ChildTable → TRAV_EXISTS_NOT_COLLECTION ──────────────

        [Fact]
        public void Condition_filter_exists_collection_not_child_table_flagged()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [lookupId] = new TableConfig { Id = lookupId, ConfigType = TableConfigType.LookupTable, ParentTableId = rootId, TableLogicalName = "contact", LookupTargetIdAttribute = "contactid" },
            };
            var criterion = new NodeFilterCriterion { Kind = CriterionKind.Exists, CollectionNodeId = lookupId, SubFilter = new NodeFilterGroup() };
            var model = ConditionModel(configs, GroupWithFilter(criterion, rootId));

            var issues = new TraversalChecks().Check(model).ToList();

            Assert.Contains(issues, i => i.Code == "TRAV_EXISTS_NOT_COLLECTION");
        }

        // ── (b) collection node not in tree → TRAV_NODE_NOT_FOUND (both surfaces) ──────────

        [Fact]
        public void Condition_filter_exists_collection_missing_flagged_not_found()
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
            };
            var criterion = new NodeFilterCriterion { Kind = CriterionKind.Exists, CollectionNodeId = Guid.NewGuid(), SubFilter = new NodeFilterGroup() };
            var model = ConditionModel(configs, GroupWithFilter(criterion, rootId));

            var issues = new TraversalChecks().Check(model).ToList();

            Assert.Contains(issues, i => i.Code == "TRAV_NODE_NOT_FOUND");
        }

        [Fact]
        public void Aggregate_filter_exists_collection_missing_flagged_not_found()
        {
            var rootId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [lineId] = new TableConfig { Id = lineId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
            };
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + lineId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"exists\",\"collectionNodeId\":\"" + Guid.NewGuid() + "\"," +
                          "\"sub\":{\"op\":\"and\",\"rules\":[]}}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = AggregateModel(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline" } };
            flags.Cols["sample_orderline.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Contains(issues, i => i.Code == "TRAV_NODE_NOT_FOUND" && i.Target.Kind == TargetKind.Action && i.Target.Id == action.Id);
        }

        // ── (c) sub-filter column absent from the collection's table → META_FILTER_COLUMN_NOT_FOUND (both surfaces) ──

        [Fact]
        public void Condition_filter_exists_subfilter_column_not_on_collection_table_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "contact" },
            };
            var criterion = new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = childId,
                SubFilter = new NodeFilterGroup
                {
                    LogicalOperator = LogicalOperator.And,
                    Criteria = new List<NodeFilterCriterion>
                    {
                        new NodeFilterCriterion { FieldName = "ghost", Operator = "eq", Value = "x" },
                    },
                },
            };
            var model = ConditionModel(configs, GroupWithFilter(criterion, rootId));
            var flags = new FakeFlags { Tables = { "account", "contact" } };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Contains(issues, i => i.Code == "META_FILTER_COLUMN_NOT_FOUND");
        }

        [Fact]
        public void Aggregate_filter_exists_subfilter_column_not_on_collection_table_flagged()
        {
            var rootId = Guid.NewGuid();
            var lineId = Guid.NewGuid();
            var collId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [lineId] = new TableConfig { Id = lineId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
                [collId] = new TableConfig { Id = collId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_contact" },
            };
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + lineId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"exists\",\"collectionNodeId\":\"" + collId + "\"," +
                          "\"sub\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"rule\",\"column\":\"ghost\",\"operator\":1,\"valueSource\":1,\"value\":\"x\"}]}}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = AggregateModel(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline", "sample_contact" } };
            flags.Cols["sample_orderline.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Contains(issues, i => i.Code == "META_FILTER_COLUMN_NOT_FOUND" && i.Target.Kind == TargetKind.Action && i.Target.Id == action.Id);
        }

        // ── (d) MinCount > MaxCount → META_EXISTS_COUNT_RANGE ───────────────────────────────

        [Fact]
        public void Condition_filter_exists_min_greater_than_max_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "contact" },
            };
            var criterion = new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = childId,
                MinCount = 5,
                MaxCount = 2,
                SubFilter = new NodeFilterGroup(),
            };
            var model = ConditionModel(configs, GroupWithFilter(criterion, rootId));
            var flags = new FakeFlags { Tables = { "account", "contact" } };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Contains(issues, i => i.Code == "META_EXISTS_COUNT_RANGE");
        }

        [Theory]
        [InlineData(-1, null)]   // negativeMin
        [InlineData(null, -1)]   // negativeMax
        public void Condition_filter_exists_with_a_negative_count_bound_is_flagged(int? min, int? max)
        {
            // MetadataChecks:135 ORs three legs; only the inverted-range leg had a test.
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "contact" },
            };
            var criterion = new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = childId,
                MinCount = min,
                MaxCount = max,
                SubFilter = new NodeFilterGroup(),
            };
            var model = ConditionModel(configs, GroupWithFilter(criterion, rootId));
            var flags = new FakeFlags { Tables = { "account", "contact" } };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Contains(issues, i => i.Code == "META_EXISTS_COUNT_RANGE");
        }

        [Fact]
        public void Condition_filter_exists_valid_range_not_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "contact" },
            };
            var criterion = new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = childId,
                MinCount = 1,
                MaxCount = 2,
                SubFilter = new NodeFilterGroup(),
            };
            var model = ConditionModel(configs, GroupWithFilter(criterion, rootId));
            var flags = new FakeFlags { Tables = { "account", "contact" } };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.DoesNotContain(issues, i => i.Code == "META_EXISTS_COUNT_RANGE");
        }

        // ── (e) Exists inside an Exists sub-filter → STRUCT_NESTED_EXISTS ───────────────────

        [Fact]
        public void Condition_filter_nested_exists_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var grandchildId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "contact" },
                [grandchildId] = new TableConfig { Id = grandchildId, ConfigType = TableConfigType.ChildTable, ParentTableId = childId, TableLogicalName = "opportunity" },
            };
            var inner = new NodeFilterCriterion { Kind = CriterionKind.Exists, CollectionNodeId = grandchildId, SubFilter = new NodeFilterGroup() };
            var outer = new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = childId,
                SubFilter = new NodeFilterGroup { Criteria = new List<NodeFilterCriterion> { inner } },
            };
            var model = ConditionModel(configs, GroupWithFilter(outer, rootId));

            var issues = new StructuralChecks().Check(model).ToList();

            Assert.Contains(issues, i => i.Code == "STRUCT_NESTED_EXISTS");
        }

        [Fact]
        public void Condition_filter_single_level_exists_not_flagged_nested()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "contact" },
            };
            var criterion = new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = childId,
                SubFilter = new NodeFilterGroup
                {
                    Criteria = new List<NodeFilterCriterion> { new NodeFilterCriterion { FieldName = "name", Operator = "eq", Value = "x" } },
                },
            };
            var model = ConditionModel(configs, GroupWithFilter(criterion, rootId));

            var issues = new StructuralChecks().Check(model).ToList();

            Assert.DoesNotContain(issues, i => i.Code == "STRUCT_NESTED_EXISTS");
        }

        // ── extra structural coverage: required fields ──────────────────────────────────────

        [Fact]
        public void Exists_criterion_without_collection_node_flagged_missing_field()
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
            };
            var criterion = new NodeFilterCriterion { Kind = CriterionKind.Exists, CollectionNodeId = null, SubFilter = new NodeFilterGroup() };
            var model = ConditionModel(configs, GroupWithFilter(criterion, rootId));

            var issues = new StructuralChecks().Check(model).ToList();

            Assert.Contains(issues, i => i.Code == "STRUCT_MISSING_FIELD");
        }

        [Fact]
        public void Comparison_criterion_with_exists_fields_flagged()
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
            };
            var criterion = new NodeFilterCriterion
            {
                Kind = CriterionKind.Comparison,
                FieldName = "name",
                Operator = "eq",
                Value = "x",
                CollectionNodeId = Guid.NewGuid(), // Exists-only field set on a Comparison criterion
            };
            var model = ConditionModel(configs, GroupWithFilter(criterion, rootId));

            var issues = new StructuralChecks().Check(model).ToList();

            Assert.Contains(issues, i => i.Code == "STRUCT_COMPARISON_HAS_EXISTS_FIELDS");
        }

        // ── (f) shared filter key + invalid Exists count range must not double-report ──────
        // (mirrors AggregateFilterValidationTests' "many_cardinality_value_node_flagged_once":
        // the Exists criterion's checks (count-range + sub-filter) are table-independent, so when
        // two aggregates on DIFFERENT tables reference the same filter key, they must fire exactly
        // once for that filter key, not once per distinct aggregate table.)

        [Fact]
        public void Aggregate_filter_shared_by_two_aggregates_exists_count_range_flagged_once()
        {
            var rootId = Guid.NewGuid();
            var childAId = Guid.NewGuid();
            var childBId = Guid.NewGuid();
            var collId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childAId] = new TableConfig { Id = childAId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
                [childBId] = new TableConfig { Id = childBId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline_other" },
                [collId] = new TableConfig { Id = collId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_contact" },
            };
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + childAId + ".sample_amount filter:f1) + sum(node:" + childBId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"exists\",\"collectionNodeId\":\"" + collId + "\",\"minCount\":5,\"maxCount\":2," +
                          "\"sub\":{\"op\":\"and\",\"rules\":[]}}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = AggregateModel(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline", "sample_orderline_other", "sample_contact" } };
            flags.Cols["sample_orderline.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };
            flags.Cols["sample_orderline_other.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Equal(1, issues.Count(i => i.Code == "META_EXISTS_COUNT_RANGE"));
        }

        // ── clean case: a fully valid Exists criterion is not flagged by any layer ──────────

        [Fact]
        public void Valid_exists_criterion_not_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "contact" },
            };
            var criterion = new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = childId,
                MinCount = 1,
                MaxCount = 3,
                SubFilter = new NodeFilterGroup
                {
                    Criteria = new List<NodeFilterCriterion> { new NodeFilterCriterion { FieldName = "lastname", Operator = "eq", Value = "x" } },
                },
            };
            var model = ConditionModel(configs, GroupWithFilter(criterion, rootId));
            var flags = new FakeFlags { Tables = { "account", "contact" } };
            flags.Cols["contact.lastname"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };

            var structIssues = new StructuralChecks().Check(model).ToList();
            var travIssues = new TraversalChecks().Check(model).ToList();
            var metaIssues = new MetadataChecks().Check(model, flags).ToList();

            Assert.DoesNotContain(structIssues, i => i.Code.StartsWith("STRUCT") && i.Code.Contains("EXISTS"));
            Assert.DoesNotContain(travIssues, i => i.Code == "TRAV_EXISTS_NOT_COLLECTION" || i.Code == "TRAV_NODE_NOT_FOUND");
            Assert.DoesNotContain(metaIssues, i => i.Code == "META_FILTER_COLUMN_NOT_FOUND" || i.Code == "META_EXISTS_COUNT_RANGE");
        }
    }
}
