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
    /// Server validation for an aggregate's filter (a mathexpr field-mapping entry's `filters`
    /// map, keyed by an aggregate's `filter:&lt;key&gt;` token). Covers key integrity (surfaced by
    /// FieldMappingParser's parse-time check, caught into a structural issue rather than an
    /// unhandled throw), and the node-filter filter-criteria checks (column/operator/value-column)
    /// plus value-node cardinality, reused against the owning aggregate's node table.
    /// </summary>
    public class AggregateFilterValidationTests
    {
        private class FakeFlags : IAttributeFlagsProvider
        {
            public HashSet<string> Tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public Dictionary<string, AttributeFlags> Cols = new Dictionary<string, AttributeFlags>(StringComparer.OrdinalIgnoreCase);
            public bool TableExists(string table) => Tables.Contains(table);
            public AttributeFlags GetFlags(string table, string column)
                => Cols.TryGetValue(table + "." + column, out var f) ? f : null;
        }

        private static RuleForValidation Model(Dictionary<Guid, TableConfig> configs, RuleAction action, Guid rootId)
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

        // ── (a) key-integrity: parser throws, must be caught into a structural issue ────────

        [Fact]
        public void Filter_key_mismatch_surfaces_as_structural_issue_not_throw()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
            };
            // Expression references filter:f1, but 'filters' defines key 'f2': simultaneously a
            // missing key (f1 undefined) and an orphaned entry (f2 unreferenced).
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + childId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f2\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"rule\",\"column\":\"name\",\"operator\":1,\"valueSource\":1,\"value\":\"x\"}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = Model(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline" } };

            var report = RuleValidator.Validate(model, flags); // must not throw

            Assert.Contains(report.Issues, i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Kind == TargetKind.Action && i.Target.Id == action.Id);
        }

        [Fact]
        public void Orphaned_filter_entry_surfaces_as_structural_issue_not_throw()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
            };
            // Unfiltered aggregate, but 'filters' defines an orphaned entry 'f1'.
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + childId + ".sample_amount)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"rule\",\"column\":\"name\",\"operator\":1,\"valueSource\":1,\"value\":\"x\"}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = Model(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline" } };

            var report = RuleValidator.Validate(model, flags); // must not throw

            Assert.Contains(report.Issues, i => i.Code == "STRUCT_MISSING_FIELD" && i.Target.Kind == TargetKind.Action && i.Target.Id == action.Id);
        }

        // ── (b) filter column absent from the aggregate's node table ───────────────────────

        [Fact]
        public void Filter_column_not_on_aggregate_node_table_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
            };
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + childId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"rule\",\"column\":\"ghost\",\"operator\":1,\"valueSource\":1,\"value\":\"x\"}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = Model(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline" } };
            flags.Cols["sample_orderline.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Contains(issues, i => i.Code == "META_FILTER_COLUMN_NOT_FOUND" && i.Target.Kind == TargetKind.Action && i.Target.Id == action.Id);
        }

        // ── (c) ordering operator on a text column ──────────────────────────────────────────

        [Fact]
        public void Ordering_operator_on_filter_text_column_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
            };
            // operator 3 == "gt" (an ordering operator) on a String column.
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + childId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"rule\",\"column\":\"name\",\"operator\":3,\"valueSource\":1,\"value\":\"x\"}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = Model(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline" } };
            flags.Cols["sample_orderline.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };
            flags.Cols["sample_orderline.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Contains(issues, i => i.Code == "META_FILTER_OPERATOR_TYPE_MISMATCH" && i.Target.Kind == TargetKind.Action && i.Target.Id == action.Id);
        }

        // ── (d) FieldReference value-node that is many-cardinality ─────────────────────────

        [Fact]
        public void Filter_value_node_many_cardinality_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var otherChildId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
                [otherChildId] = new TableConfig { Id = otherChildId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline_other" },
            };
            // valueSource 2 == FieldReference, pointing at otherChildId, a many-cardinality node.
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + childId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"rule\",\"column\":\"sample_amount\",\"operator\":1,\"valueSource\":2," +
                          "\"valueNodeId\":\"" + otherChildId + "\",\"valueColumn\":\"sample_amount\"}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = Model(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline", "sample_orderline_other" } };
            flags.Cols["sample_orderline.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };
            flags.Cols["sample_orderline_other.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Contains(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY" && i.Target.Kind == TargetKind.Action && i.Target.Id == action.Id);
        }

        [Fact]
        public void Filter_value_node_single_cardinality_not_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
                [lookupId] = new TableConfig { Id = lookupId, ConfigType = TableConfigType.LookupTable, ParentTableId = rootId, TableLogicalName = "sample_customer" },
            };
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + childId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"rule\",\"column\":\"sample_amount\",\"operator\":1,\"valueSource\":2," +
                          "\"valueNodeId\":\"" + lookupId + "\",\"valueColumn\":\"sample_threshold\"}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = Model(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline", "sample_customer" } };
            flags.Cols["sample_orderline.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };
            flags.Cols["sample_customer.sample_threshold"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.DoesNotContain(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
        }

        // ── (e) filter key shared by two aggregates on different-typed node tables ─────────

        [Fact]
        public void Filter_shared_by_two_aggregates_validated_against_both_node_tables()
        {
            var rootId = Guid.NewGuid();
            var childAId = Guid.NewGuid();
            var childBId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childAId] = new TableConfig { Id = childAId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
                [childBId] = new TableConfig { Id = childBId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline_other" },
            };
            // Both aggregates reference the same filter key 'f1'. The filter's 'extra' column
            // exists on childA's table (sample_orderline) but NOT on childB's table
            // (sample_orderline_other): if only the first aggregate (childA) is resolved into
            // aggregatesByKey, childB's table is never validated.
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + childAId + ".sample_amount filter:f1) + sum(node:" + childBId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"rule\",\"column\":\"extra\",\"operator\":1,\"valueSource\":1,\"value\":\"x\"}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = Model(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline", "sample_orderline_other" } };
            flags.Cols["sample_orderline.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };
            flags.Cols["sample_orderline_other.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };
            flags.Cols["sample_orderline.extra"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };
            // Note: sample_orderline_other.extra is intentionally absent.

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Contains(issues, i => i.Code == "META_FILTER_COLUMN_NOT_FOUND" && i.Target.Kind == TargetKind.Action && i.Target.Id == action.Id);
        }

        // ── (f) shared filter key + many-cardinality value node must not double-report ─────

        [Fact]
        public void Filter_shared_by_two_aggregates_many_cardinality_value_node_flagged_once()
        {
            var rootId = Guid.NewGuid();
            var childAId = Guid.NewGuid();
            var childBId = Guid.NewGuid();
            var valueNodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childAId] = new TableConfig { Id = childAId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
                [childBId] = new TableConfig { Id = childBId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline_other" },
                [valueNodeId] = new TableConfig { Id = valueNodeId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline_value" },
            };
            // Both aggregates (on DIFFERENT tables) reference the same filter key 'f1', whose
            // sole criterion is a FieldReference pointing at a many-cardinality node. Cardinality
            // checking is table-independent (depends only on the filter group + model), so it
            // must fire exactly once for this filter key, not once per distinct aggregate table.
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + childAId + ".sample_amount filter:f1) + sum(node:" + childBId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"rule\",\"column\":\"sample_amount\",\"operator\":1,\"valueSource\":2," +
                          "\"valueNodeId\":\"" + valueNodeId + "\",\"valueColumn\":\"sample_amount\"}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = Model(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline", "sample_orderline_other", "sample_orderline_value" } };
            flags.Cols["sample_orderline.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };
            flags.Cols["sample_orderline_other.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };
            flags.Cols["sample_orderline_value.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.Equal(1, issues.Count(i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY"));
        }

        // ── clean case: valid filter criteria against the aggregate's node table ───────────

        [Fact]
        public void Valid_aggregate_filter_not_flagged()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "sample_orderline" },
            };
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\"," +
                          "\"expression\":\"sum(node:" + childId + ".sample_amount filter:f1)\"," +
                          "\"filters\":{\"f1\":{\"op\":\"and\",\"rules\":[" +
                          "{\"kind\":\"rule\",\"column\":\"name\",\"operator\":1,\"valueSource\":1,\"value\":\"x\"}]}}}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = Model(configs, action, rootId);
            var flags = new FakeFlags { Tables = { "sample_order", "sample_orderline" } };
            flags.Cols["sample_orderline.sample_amount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };
            flags.Cols["sample_orderline.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };

            var issues = new MetadataChecks().Check(model, flags).ToList();

            Assert.DoesNotContain(issues, i => i.Code == "META_FILTER_COLUMN_NOT_FOUND");
            Assert.DoesNotContain(issues, i => i.Code == "META_FILTER_OPERATOR_TYPE_MISMATCH");
            Assert.DoesNotContain(issues, i => i.Code == "META_FILTER_VALUE_COLUMN_NOT_FOUND");
            Assert.DoesNotContain(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
        }
    }
}
