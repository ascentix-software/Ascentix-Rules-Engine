using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Validation;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class TraversalChecksTests
    {
        private static RuleForValidation Model(
            Dictionary<Guid, TableConfig> configs,
            List<RuleCondition> conditions = null,
            List<RuleAction> actions = null)
        {
            var grp = new ConditionGroup
            {
                Id = Guid.NewGuid(),
                Conditions = conditions ?? new List<RuleCondition>(),
                ChildGroups = new List<ConditionGroup>(),
            };
            return new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                PrimaryTable = "account",
                Groups = new List<ConditionGroup> { grp },
                Configs = TestTree.RawTree(configs),
                Actions = actions ?? new List<RuleAction>(),
            };
        }

        private static List<ValidationIssue> Run(RuleForValidation m) => new TraversalChecks().Check(m).ToList();

        [Fact]
        public void Field_reference_to_missing_node_flagged()
        {
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ConditionType = ConditionType.FieldComparison,
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = Guid.NewGuid(), // not in Configs
                ComparisonValueColumn = "x",
            };
            var m = Model(new Dictionary<Guid, TableConfig>(), new List<RuleCondition> { cond });
            Assert.Contains(Run(m), i => i.Code == "TRAV_NODE_NOT_FOUND");
        }

        [Fact]
        public void Update_target_on_child_node_is_not_single_cardinality()
        {
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.ChildTable, ParentTableId = null }
            };
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = nodeId };
            var m = Model(configs, actions: new List<RuleAction> { action });
            Assert.Contains(Run(m), i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
        }

        [Fact]
        public void Update_target_lookup_node_with_null_parent_is_not_single_cardinality()
        {
            // Pins a deliberate divergence from the pre-reroute NodeCardinality.IsSingle (see
            // aed78f8): a non-root, non-child node (LookupTable) whose ParentTableId is null.
            // Old IsSingle checked ChildTable, then "no parent" -> true (single, no issue) without
            // ever checking RootTable. SingleCardinality checks RootTable before the null-parent
            // check, so this same shape now returns false -> "not single" -> an issue is raised
            // where none was before. This shape isn't proven unreachable (a partially-migrated
            // config or an editor bug could produce a non-root node with no parent), so failing
            // closed (flagging it rather than silently treating it as single) is the deliberate,
            // safety-directed choice for a validator.
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.LookupTable, ParentTableId = null }
            };
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = nodeId };
            var m = Model(configs, actions: new List<RuleAction> { action });
            Assert.Contains(Run(m), i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
        }

        [Fact]
        public void Field_reference_through_a_parentless_non_root_is_not_single_and_unreachable()
        {
            // Only a Root Table node terminates a chain. A lookup whose parent is a
            // parentless non-root (an orphan) is malformed, and the validator's tree is
            // UNVALIDATED, so the answers must be the conservative ones (not single-cardinality,
            // not reachable), and the sweep must report rather than throw.
            var orphanId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [orphanId] = new TableConfig { Id = orphanId, ConfigType = TableConfigType.LookupTable, TableLogicalName = "account", ParentTableId = null },
                [lookupId] = new TableConfig { Id = lookupId, ConfigType = TableConfigType.LookupTable, TableLogicalName = "contact", ParentTableId = orphanId },
            };
            var cond = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ConditionType = ConditionType.FieldComparison,
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = lookupId,
                ComparisonValueColumn = "x",
            };
            var m = Model(configs, new List<RuleCondition> { cond });

            Assert.Equal(ChainShape.OrphanNonRoot, m.Configs.ChainDiagnosis(lookupId).Shape);
            Assert.False(m.Configs.TrySingleCardinality(lookupId));
            Assert.False(m.Configs.IsReachableFromRoot(lookupId));

            var issues = Run(m);
            Assert.Contains(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
            Assert.DoesNotContain(issues, i => i.Code == "TRAV_NODE_NOT_FOUND");
        }

        [Fact]
        public void Lookup_node_target_is_single_cardinality_ok()
        {
            var rootId = Guid.NewGuid();
            var nodeId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable },
                [nodeId] = new TableConfig { Id = nodeId, ConfigType = TableConfigType.LookupTable, ParentTableId = rootId }
            };
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = nodeId };
            var m = Model(configs, actions: new List<RuleAction> { action });
            Assert.DoesNotContain(Run(m), i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY" || i.Code == "TRAV_NODE_NOT_FOUND");
        }

        [Fact]
        public void Lookup_node_missing_target_id_flagged()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "perf_root" },
                [lookupId] = new TableConfig { Id = lookupId, ConfigType = TableConfigType.LookupTable, TableLogicalName = "perf_lookup1", ParentTableId = rootId, LookupTargetIdAttribute = null },
            };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "perf_root", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction>() };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_LOOKUP_MISSING_TARGET_ID");
        }

        [Fact]
        public void Lookup_node_with_target_id_not_flagged()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "perf_root" },
                [lookupId] = new TableConfig { Id = lookupId, ConfigType = TableConfigType.LookupTable, TableLogicalName = "perf_lookup1", ParentTableId = rootId, LookupTargetIdAttribute = "perf_lookup1id" },
            };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "perf_root", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction>() };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "TRAV_LOOKUP_MISSING_TARGET_ID");
        }

        [Fact]
        public void Non_lookup_nodes_not_flagged_for_target_id()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "perf_root" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, TableLogicalName = "perf_child1", ParentTableId = rootId, ChildLinkField = "perf_rootid", LookupTargetIdAttribute = null },
            };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "perf_root", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction>() };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "TRAV_LOOKUP_MISSING_TARGET_ID");
        }

        [Fact]
        public void Update_target_lookup_under_child_flagged_single_cardinality()
        {
            var rootId = Guid.NewGuid(); var childId = Guid.NewGuid(); var lkUnderChildId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, TableLogicalName = "contact", ParentTableId = rootId, ChildLinkField = "parentcustomerid" },
                [lkUnderChildId] = new TableConfig { Id = lkUnderChildId, ConfigType = TableConfigType.LookupTable, TableLogicalName = "account", ParentTableId = childId, LookupColumnLogicalName = "parentaccountid" },
            };
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = lkUnderChildId, FieldMapping = "[]" };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "account", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction> { action } };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
        }

        [Fact]
        public void Mapping_node_source_child_flagged()
        {
            var rootId = Guid.NewGuid(); var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, TableLogicalName = "contact", ParentTableId = rootId, ChildLinkField = "parentcustomerid" },
            };
            var mapping = "[{\"target\":\"name\",\"source\":\"node\",\"column\":\"lastname\",\"node\":\"" + childId + "\"}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.CreateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetTable = "task", FieldMapping = mapping };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "account", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction> { action } };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
        }

        [Fact]
        public void Mapping_dateexpr_anchor_child_flagged()
        {
            var rootId = Guid.NewGuid(); var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, TableLogicalName = "contact", ParentTableId = rootId, ChildLinkField = "parentcustomerid" },
            };
            var mapping = "[{\"target\":\"scheduledend\",\"source\":\"dateexpr\",\"anchor\":{\"kind\":\"field\",\"column\":\"createdon\",\"node\":\"" + childId + "\"},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.CreateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetTable = "task", FieldMapping = mapping };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "account", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction> { action } };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
        }

        [Fact]
        public void Mapping_node_source_lookup_not_flagged()
        {
            var rootId = Guid.NewGuid(); var lkId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
                [lkId] = new TableConfig { Id = lkId, ConfigType = TableConfigType.LookupTable, TableLogicalName = "contact", ParentTableId = rootId, LookupColumnLogicalName = "primarycontactid" },
            };
            var mapping = "[{\"target\":\"name\",\"source\":\"node\",\"column\":\"lastname\",\"node\":\"" + lkId + "\"}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.CreateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetTable = "task", FieldMapping = mapping };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "account", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction> { action } };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
        }

        [Fact]
        public void Mapping_mathexpr_aggregate_over_child_not_flagged_single_cardinality()
        {
            var rootId = Guid.NewGuid(); var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, TableLogicalName = "sample_orderline", ParentTableId = rootId, ChildLinkField = "sample_orderid" },
            };
            // An aggregate over the child collection is exactly what aggregates are for, so it must NOT be flagged.
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\",\"expression\":\"sum(node:" + childId + ".sample_lineamount)\"}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "sample_order", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction> { action } };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.DoesNotContain(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
            Assert.DoesNotContain(issues, i => i.Code == "TRAV_AGGREGATE_NOT_COLLECTION");
        }

        [Fact]
        public void Mapping_mathexpr_scalar_node_child_still_flagged_single_cardinality()
        {
            var rootId = Guid.NewGuid(); var childId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [childId] = new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, TableLogicalName = "sample_orderline", ParentTableId = rootId, ChildLinkField = "sample_orderid" },
            };
            // A SCALAR {node:...} operand over a child is still an error (a many-node scalar read is ambiguous).
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\",\"expression\":\"{node:" + childId + ".sample_lineamount} * 2\"}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "sample_order", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction> { action } };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_NOT_SINGLE_CARDINALITY");
        }

        [Fact]
        public void Mapping_mathexpr_aggregate_over_single_cardinality_flagged_not_collection()
        {
            var rootId = Guid.NewGuid(); var lookupId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "sample_order" },
                [lookupId] = new TableConfig { Id = lookupId, ConfigType = TableConfigType.LookupTable, TableLogicalName = "sample_customer", ParentTableId = rootId, LookupColumnLogicalName = "sample_customerid" },
            };
            // Aggregating a single-cardinality (lookup) node is an author error.
            var mapping = "[{\"target\":\"sample_total\",\"source\":\"mathexpr\",\"expression\":\"sum(node:" + lookupId + ".sample_amount)\"}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = rootId, FieldMapping = mapping };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "sample_order", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction> { action } };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_AGGREGATE_NOT_COLLECTION");
        }

        [Fact]
        public void Mapping_node_source_missing_node_flagged_not_found()
        {
            var rootId = Guid.NewGuid();
            var configs = new Dictionary<Guid, TableConfig>
            {
                [rootId] = new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable, TableLogicalName = "account" },
            };
            var mapping = "[{\"target\":\"name\",\"source\":\"node\",\"column\":\"lastname\",\"node\":\"" + Guid.NewGuid() + "\"}]";
            var action = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.CreateRecord, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetTable = "task", FieldMapping = mapping };
            var model = new RuleForValidation { RuleId = Guid.NewGuid(), PrimaryTable = "account", Groups = new List<ConditionGroup>(), Configs = TestTree.RawTree(configs), Actions = new List<RuleAction> { action } };
            var issues = new TraversalChecks().Check(model).ToList();
            Assert.Contains(issues, i => i.Code == "TRAV_NODE_NOT_FOUND");
        }
    }
}
