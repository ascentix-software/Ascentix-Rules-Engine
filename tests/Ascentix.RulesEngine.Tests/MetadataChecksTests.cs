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
    public class MetadataChecksTests
    {
        private class FakeFlags : IAttributeFlagsProvider
        {
            public HashSet<string> Tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public Dictionary<string, AttributeFlags> Cols = new Dictionary<string, AttributeFlags>(StringComparer.OrdinalIgnoreCase);
            public bool TableExists(string table) => Tables.Contains(table);
            public AttributeFlags GetFlags(string table, string column)
                => Cols.TryGetValue(table + "." + column, out var f) ? f : null;
        }

        private static RuleForValidation ModelWithCondition(RuleCondition c, Dictionary<Guid, TableConfig> configs)
        {
            var grp = new ConditionGroup { Id = Guid.NewGuid(), Conditions = new List<RuleCondition> { c }, ChildGroups = new List<ConditionGroup>() };
            return new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "account", Groups = new List<ConditionGroup> { grp }, Configs = TestTree.RawTree(configs), Actions = new List<RuleAction>() };
        }

        [Fact]
        public void Unknown_comparison_column_flagged()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison, TableConfigNodeId = nodeId, ComparisonColumn = "ghost", ComparisonOperator = ComparisonOperator.Equals };
            var flags = new FakeFlags { Tables = { "account" } };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_COLUMN_NOT_FOUND");
        }

        [Fact]
        public void Ordering_operator_on_string_flagged()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison, TableConfigNodeId = nodeId, ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.GreaterThan };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Create_record_to_unknown_table_flagged()
        {
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.CreateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetTable = "ghosttable", FieldMapping = "[]" };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "account", Groups = new List<ConditionGroup>(), Configs = TableConfigTree.Empty, Actions = new List<RuleAction> { action } };
            var flags = new FakeFlags { Tables = { "account" } };
            var issues = new MetadataChecks().Check(model, flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_TABLE_NOT_FOUND");
        }

        [Fact]
        public void Create_mapping_to_non_creatable_column_flagged()
        {
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.CreateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetTable = "task", FieldMapping = "[{\"target\":\"createdon\",\"source\":\"literal\",\"value\":\"x\"}]" };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "account", Groups = new List<ConditionGroup>(), Configs = TableConfigTree.Empty, Actions = new List<RuleAction> { action } };
            var flags = new FakeFlags { Tables = { "task" } };
            flags.Cols["task.createdon"] = new AttributeFlags { IsValidForCreate = false, Type = AttributeTypeCode.DateTime };
            var issues = new MetadataChecks().Check(model, flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_COLUMN_NOT_CREATABLE");
        }

        [Fact]
        public void Contains_on_number_flagged()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison, TableConfigNodeId = nodeId, ComparisonColumn = "numberofemployees", ComparisonOperator = ComparisonOperator.Contains };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.numberofemployees"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Integer };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Ordering_on_boolean_flagged()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison, TableConfigNodeId = nodeId, ComparisonColumn = "donotemail", ComparisonOperator = ComparisonOperator.GreaterThan };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.donotemail"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Boolean };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Datetime_ordering_allowed()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison, TableConfigNodeId = nodeId, ComparisonColumn = "createdon", ComparisonOperator = ComparisonOperator.GreaterThanOrEqual };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.createdon"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.DateTime };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "META_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Equals_on_string_allowed()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison, TableConfigNodeId = nodeId, ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.Equals };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "META_OPERATOR_TYPE_MISMATCH");
        }

        // ── Expression condition ────────────────────────────────────────────

        [Fact]
        public void Expression_non_numeric_operator_flagged()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = nodeId, Expression = "1 + 1", ComparisonOperator = ComparisonOperator.Contains, ComparisonValue = "1" };
            var flags = new FakeFlags { Tables = { "account" } };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Expression_isnull_operator_flagged_not_valid_for_expression()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = nodeId, Expression = "1 + 1", ComparisonOperator = ComparisonOperator.IsNull };
            var flags = new FakeFlags { Tables = { "account" } };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Expression_numeric_operator_allowed()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = nodeId, Expression = "1 + 1", ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1" };
            var flags = new FakeFlags { Tables = { "account" } };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "META_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Expression_unparseable_does_not_throw_and_is_skipped_by_metadata_layer()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = nodeId, Expression = "1 +", ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1" };
            var flags = new FakeFlags { Tables = { "account" } };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "META_AGGREGATE_NOT_COLLECTION");
        }

        [Fact]
        public void Expression_aggregate_over_single_cardinality_node_flagged()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [lookupId] = new TableConfig { Id = lookupId, ConfigType = TableConfigType.LookupTable, ParentTableId = rootId, TableLogicalName = "primarycontact" },
            };
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = rootId,
                Expression = $"sum(node:{lookupId}.amount)",
                ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1",
            };
            var flags = new FakeFlags { Tables = { "account" } };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_AGGREGATE_NOT_COLLECTION");
        }

        [Fact]
        public void Expression_aggregate_over_lookup_with_no_parent_flagged()
        {
            // Malformed shape (not the well-formed lookup-chain case above): a LookupTable node
            // with ParentTableId == null. TraversalChecks.SingleCardinality returns false for this
            // (indistinguishable, by return value alone, from a genuine ChildTable ancestor), so
            // MetadataChecks must guard the shape explicitly rather than trust that return value.
            // Otherwise this validates clean and MathExprEvaluator throws "aggregate node is
            // single-cardinality" at runtime instead.
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [lookupId] = new TableConfig { Id = lookupId, ConfigType = TableConfigType.LookupTable, ParentTableId = null, TableLogicalName = "primarycontact" },
            };
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = rootId,
                Expression = $"sum(node:{lookupId}.amount)",
                ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1",
            };
            var flags = new FakeFlags { Tables = { "account" } };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_AGGREGATE_NOT_COLLECTION");
        }

        [Fact]
        public void Expression_aggregate_over_child_with_a_missing_ancestor_flagged()
        {
            // The aggregate node is a ChildTable, but its chain never reaches a root (the parent
            // is absent from the tree). A walker that stopped at the first ChildTable would call
            // that a collection; the tree's ChainDiagnosis keeps walking and reports
            // MissingAncestor, so the malformed shape is flagged here instead of throwing at
            // runtime in MathExprEvaluator.
            var childId = Guid.NewGuid();
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = Guid.NewGuid(), TableLogicalName = "opportunity" },
            };
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = rootId,
                Expression = $"sum(node:{childId}.amount)",
                ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1",
            };
            var flags = new FakeFlags { Tables = { "account" } };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_AGGREGATE_NOT_COLLECTION");
        }

        [Fact]
        public void Expression_aggregate_over_child_collection_allowed()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId, TableLogicalName = "opportunity" },
            };
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = rootId,
                Expression = $"sum(node:{childId}.amount)",
                ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1",
            };
            var flags = new FakeFlags { Tables = { "account" } };
            var issues = new MetadataChecks().Check(ModelWithCondition(cond, configs), flags).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "META_AGGREGATE_NOT_COLLECTION");
        }

        // ── Trigger columns ─────────────────────────────────────────────────

        [Fact]
        public void Unknown_trigger_column_flagged()
        {
            var model = new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                PrimaryTable = "sample_order",
                Groups = new List<ConditionGroup>(),
                Configs = TableConfigTree.Empty,
                Actions = new List<RuleAction>(),
                TriggerColumns = new List<string> { "sample_lineamount" }
            };
            var flags = new FakeFlags { Tables = { "sample_order" } };
            var issues = new MetadataChecks().Check(model, flags).ToList();
            Assert.Contains(issues, i => i.Code == "META_TRIGGER_COLUMN_NOT_FOUND");
        }

        [Fact]
        public void Known_trigger_column_not_flagged()
        {
            var model = new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                PrimaryTable = "sample_order",
                Groups = new List<ConditionGroup>(),
                Configs = TableConfigTree.Empty,
                Actions = new List<RuleAction>(),
                TriggerColumns = new List<string> { "sample_lineamount" }
            };
            var flags = new FakeFlags { Tables = { "sample_order" } };
            flags.Cols["sample_order.sample_lineamount"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };
            var issues = new MetadataChecks().Check(model, flags).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "META_TRIGGER_COLUMN_NOT_FOUND");
        }

        [Fact]
        public void Date_expression_on_non_date_filter_column_is_flagged()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison, TableConfigNodeId = nodeId, ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.IsNotNull };
            var model = ModelWithCondition(cond, configs);
            model.Groups.First().NodeFilterGroups = new List<NodeFilterGroup>
            {
                new NodeFilterGroup
                {
                    TableConfigNodeId = nodeId, LogicalOperator = LogicalOperator.And,
                    Criteria = new List<NodeFilterCriterion>
                    {
                        new NodeFilterCriterion { FieldName = "name", Operator = "ge", ValueSource = ComparisonValueSource.DateExpression,
                            Value = "{\"anchor\":{\"kind\":\"now\"},\"op\":\"subtract\",\"amount\":1,\"unit\":\"days\"}" },
                    },
                },
            };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };

            var issues = new MetadataChecks().Check(model, flags).ToList();
            Assert.Single(issues, i => i.Code == "META_FILTER_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Date_expression_with_valueless_operator_on_non_date_column_is_not_flagged()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison, TableConfigNodeId = nodeId, ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.IsNotNull };
            var model = ModelWithCondition(cond, configs);
            model.Groups.First().NodeFilterGroups = new List<NodeFilterGroup>
            {
                new NodeFilterGroup
                {
                    TableConfigNodeId = nodeId, LogicalOperator = LogicalOperator.And,
                    Criteria = new List<NodeFilterCriterion>
                    {
                        new NodeFilterCriterion { FieldName = "name", Operator = "null", ValueSource = ComparisonValueSource.DateExpression, Value = null },
                    },
                },
            };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };

            var issues = new MetadataChecks().Check(model, flags).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "META_FILTER_OPERATOR_TYPE_MISMATCH");
        }

        [Fact]
        public void Date_expression_row_anchor_column_must_exist()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig> { [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" } };
            var cond = new RuleCondition { Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison, TableConfigNodeId = nodeId, ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.IsNotNull };
            var model = ModelWithCondition(cond, configs);
            model.Groups.First().NodeFilterGroups = new List<NodeFilterGroup>
            {
                new NodeFilterGroup
                {
                    TableConfigNodeId = nodeId, LogicalOperator = LogicalOperator.And,
                    Criteria = new List<NodeFilterCriterion>
                    {
                        new NodeFilterCriterion { FieldName = "createdon", Operator = "le", ValueSource = ComparisonValueSource.DateExpression,
                            Value = "{\"anchor\":{\"kind\":\"field\",\"node\":null,\"column\":\"ghostdate\"},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}" },
                    },
                },
            };
            var flags = new FakeFlags { Tables = { "account" } };
            flags.Cols["account.createdon"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.DateTime };

            Assert.Contains(new MetadataChecks().Check(model, flags), i => i.Code == "META_FILTER_VALUE_COLUMN_NOT_FOUND");
        }

        [Fact]
        public void Expression_condition_filter_column_is_checked_against_the_aggregate_table()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, TableLogicalName = "opportunity", ParentTableId = rootId, ChildLinkField = "parentaccountid" },
            };
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = rootId,
                Expression = $"sum(node:{childId}.estimatedvalue filter:f1)",
                ExpressionFilters = "{\"f1\":{\"kind\":\"group\",\"op\":\"and\",\"rules\":[{\"kind\":\"rule\",\"column\":\"ghost\",\"operator\":1,\"valueSource\":1,\"value\":\"0\"}]}}",
                ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1",
            };
            var flags = new FakeFlags { Tables = { "account", "opportunity" } };
            flags.Cols["opportunity.estimatedvalue"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.Money };

            Assert.Contains(new MetadataChecks().Check(ModelWithCondition(cond, configs), flags), i => i.Code == "META_FILTER_COLUMN_NOT_FOUND");
        }

        // ─── A filter date-expression anchor on a node missing from the tree ──────────

        private static readonly Guid GhostNode = Guid.NewGuid();

        private static string GhostAnchor =>
            "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + GhostNode + "\",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}";

        private static NodeFilterCriterion GhostDateCrit() => new NodeFilterCriterion
        { FieldName = "createdon", Operator = "le", ValueSource = ComparisonValueSource.DateExpression, Value = GhostAnchor };

        private static string GhostFilterMap =>
            "{\"f1\":{\"kind\":\"group\",\"op\":\"and\",\"rules\":[{\"kind\":\"rule\",\"column\":\"createdon\",\"operator\":6,"
            + "\"valueSource\":4,\"value\":\"" + GhostAnchor.Replace("\"", "\\\"") + "\"}]}}";

        private static (Dictionary<Guid, TableConfig> configs, Guid rootId, Guid childId, FakeFlags flags) AnchorFixture()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, TableLogicalName = "opportunity", ParentTableId = rootId, ChildLinkField = "parentaccountid" },
            };
            var flags = new FakeFlags { Tables = { "account", "opportunity" } };
            flags.Cols["account.name"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.String };
            flags.Cols["account.createdon"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.DateTime };
            flags.Cols["opportunity.createdon"] = new AttributeFlags { IsValidForRead = true, Type = AttributeTypeCode.DateTime };
            flags.Cols["opportunity.estimatedvalue"] = new AttributeFlags { IsValidForRead = true, IsValidForUpdate = true, Type = AttributeTypeCode.Money };
            flags.Cols["account.revenue"] = new AttributeFlags { IsValidForRead = true, IsValidForUpdate = true, IsValidForCreate = true, Type = AttributeTypeCode.Money };
            return (configs, rootId, childId, flags);
        }

        private static RuleCondition NameNotNull(Guid rootId) => new RuleCondition
        { Id = Guid.NewGuid(), ConditionType = ConditionType.FieldComparison, TableConfigNodeId = rootId, ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.IsNotNull };

        [Fact]
        public void Missing_anchor_node_in_a_condition_filter_is_node_not_found()
        {
            var (configs, rootId, _, flags) = AnchorFixture();
            var model = ModelWithCondition(NameNotNull(rootId), configs);
            model.Groups.First().NodeFilterGroups = new List<NodeFilterGroup>
            { new NodeFilterGroup { TableConfigNodeId = rootId, LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { GhostDateCrit() } } };

            Assert.Single(RuleValidator.Validate(model, flags).Issues, i => i.Code == "TRAV_NODE_NOT_FOUND");
        }

        [Fact]
        public void Missing_anchor_node_in_an_exists_sub_filter_is_node_not_found()
        {
            var (configs, rootId, childId, flags) = AnchorFixture();
            var model = ModelWithCondition(NameNotNull(rootId), configs);
            model.Groups.First().NodeFilterGroups = new List<NodeFilterGroup>
            {
                new NodeFilterGroup
                {
                    TableConfigNodeId = rootId, LogicalOperator = LogicalOperator.And,
                    Criteria = new List<NodeFilterCriterion>
                    {
                        new NodeFilterCriterion
                        {
                            Kind = CriterionKind.Exists, CollectionNodeId = childId, MinCount = 1,
                            SubFilter = new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion> { GhostDateCrit() } },
                        },
                    },
                },
            };

            Assert.Single(RuleValidator.Validate(model, flags).Issues, i => i.Code == "TRAV_NODE_NOT_FOUND");
        }

        [Fact]
        public void Missing_anchor_node_in_a_calculation_filter_is_node_not_found()
        {
            var (configs, rootId, childId, flags) = AnchorFixture();
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(), ConditionType = ConditionType.Expression, TableConfigNodeId = rootId,
                Expression = $"sum(node:{childId}.estimatedvalue filter:f1)", ExpressionFilters = GhostFilterMap,
                ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1",
            };

            Assert.Single(RuleValidator.Validate(ModelWithCondition(cond, configs), flags).Issues, i => i.Code == "TRAV_NODE_NOT_FOUND");
        }

        [Fact]
        public void Missing_anchor_node_in_a_mapping_filter_is_node_not_found()
        {
            var (configs, rootId, childId, flags) = AnchorFixture();
            var grp = new ConditionGroup { Id = Guid.NewGuid(), Conditions = new List<RuleCondition> { NameNotNull(rootId) }, ChildGroups = new List<ConditionGroup>() };
            var action = new RuleAction
            {
                Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId,
                FieldMapping = "[{\"target\":\"revenue\",\"source\":\"mathexpr\",\"expression\":\"sum(node:" + childId + ".estimatedvalue filter:f1)\","
                    + "\"filters\":" + GhostFilterMap + "}]",
            };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "account", Groups = new List<ConditionGroup> { grp }, Configs = TestTree.RawTree(configs), Actions = new List<RuleAction> { action } };

            Assert.Single(RuleValidator.Validate(model, flags).Issues, i => i.Code == "TRAV_NODE_NOT_FOUND");
        }
    }
}
