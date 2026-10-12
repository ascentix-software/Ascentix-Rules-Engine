using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleReferencesSetActionTests
    {
        private static readonly Guid Root = Guid.NewGuid(), Contacts = Guid.NewGuid(), Tasks = Guid.NewGuid(), Value = Guid.NewGuid(), Owner = Guid.NewGuid();

        private static TableConfigTree Tree() => TestTree.Tree(
            TestTree.Node(Root, "account", TableConfigType.RootTable, null),
            TestTree.Node(Contacts, "contact", TableConfigType.ChildTable, Root, "parentcustomerid"),
            TestTree.Node(Tasks, "task", TableConfigType.ChildTable, Contacts, "regardingobjectid"),
            new TableConfig { Id = Owner, TableLogicalName = "systemuser", ConfigType = TableConfigType.LookupTable, ParentTableId = Root, LookupColumnLogicalName = "ownerid", LookupTargetIdAttribute = "systemuserid" });

        private static RuleAction SetUpdate() => new RuleAction
        {
            Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, IsActive = true, TargetNodeId = Contacts,
            FieldMapping = "[{\"target\":\"description\",\"source\":\"row\",\"column\":\"fullname\"}]",
            RowFilter = new NodeFilterGroup
            {
                TableConfigNodeId = Contacts, LogicalOperator = LogicalOperator.And,
                Criteria =
                {
                    new NodeFilterCriterion { FieldName = "statecode", Operator = "eq", Value = "0" },
                    new NodeFilterCriterion { FieldName = "ownerid", Operator = "eq", ValueSource = ComparisonValueSource.FieldReference,
                        ComparisonValueNodeId = Value, ComparisonValueColumn = "systemuserid" },
                    new NodeFilterCriterion { Kind = CriterionKind.Exists, CollectionNodeId = Tasks, MaxCount = 0 },
                },
            },
        };

        private static List<ConditionGroup> RootOnlyGroups() => new List<ConditionGroup>
        {
            new ConditionGroup
            {
                Id = Guid.NewGuid(),
                Conditions =
                {
                    new RuleCondition
                    {
                        Id = Guid.NewGuid(), TableConfigNodeId = Root, ConditionType = ConditionType.FieldComparison,
                        ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.Equals, ComparisonValue = "Valid",
                    },
                },
            },
        };

        private static RuleAction Block() => new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.Block, IsActive = true, Message = "Invalid" };

        private static RuleAction Create(Guid target) => new RuleAction
        {
            Id = Guid.NewGuid(), ActionType = ActionType.CreateRecord, IsActive = true, TargetNodeId = target, TargetTable = "task",
            FieldMapping = "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Follow up\"}]",
        };

        [Fact]
        public void Rows_filter_references_are_filter_derived_with_action_provenance()
        {
            var action = SetUpdate();
            var refs = RuleReferences.Compute(new List<ConditionGroup>(), new[] { action });

            Assert.Contains(refs.ReferencesByKind(ReferenceKind.FilterTargetNodes), r => r.NodeId == Contacts && r.ActionId == action.Id);
            Assert.Contains(refs.ReferencesByKind(ReferenceKind.FilterValueNodes), r => r.NodeId == Value && r.ActionId == action.Id);
            Assert.Contains(refs.ReferencesByKind(ReferenceKind.ExistsCollections), r => r.NodeId == Tasks && r.ActionId == action.Id);
            Assert.Equal(new HashSet<Guid> { Contacts, Value, Tasks }, new HashSet<Guid>(refs.ActionFilterNodes));
            Assert.Contains(Tasks, refs.NodesToLoad);
        }

        [Fact]
        public void A_create_per_row_and_a_deactivate_target_are_hard_readers()
        {
            var create = Create(Contacts);
            var deactivate = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.DeactivateRecord, IsActive = true, TargetNodeId = Tasks };
            var refs = RuleReferences.Compute(new List<ConditionGroup>(), new[] { create, deactivate }, setTargets: Tree());

            Assert.Contains(refs.ReferencesByKind(ReferenceKind.ActionTargetNodes), r => r.NodeId == Contacts && r.ActionId == create.Id);
            Assert.Contains(Contacts, refs.HardReaders);
            Assert.Contains(Contacts, refs.NodesToLoad);
            Assert.Contains(Tasks, refs.HardReaders);
        }

        [Fact]
        public void A_create_target_is_not_read_when_nothing_says_it_is_a_collection()
        {
            // Without the tree that classifies it, a Create's target is never assumed to be a set.
            var refs = RuleReferences.Compute(new List<ConditionGroup>(), new[] { Create(Contacts) });

            Assert.Empty(refs.ReferencesByKind(ReferenceKind.ActionTargetNodes));
            Assert.DoesNotContain(Contacts, refs.NodesToLoad);
        }

        [Fact]
        public void A_create_with_a_stale_single_record_target_changes_no_answer()
        {
            // A one-record Create that an earlier edit left with a lookup target (asx_targetnode) is
            // one Create, as it always was: the target is neither loaded nor read, so the rule's
            // references, its fetches and its root-only verdict (step registration) are unchanged.
            var tree = Tree();
            var groups = RootOnlyGroups();
            var before = RuleReferences.Compute(groups, new[] { Block() }, setTargets: tree);
            var after = RuleReferences.Compute(groups, new[] { Block(), Create(Owner) }, setTargets: tree);

            Assert.Equal(new HashSet<Guid>(before.NodesToLoad), new HashSet<Guid>(after.NodesToLoad));
            Assert.Equal(new HashSet<Guid>(before.OptionalNodes), new HashSet<Guid>(after.OptionalNodes));
            Assert.Equal(new HashSet<Guid>(before.HardReaders), new HashSet<Guid>(after.HardReaders));
            Assert.Equal(new HashSet<Guid>(before.NodesToPlan), new HashSet<Guid>(after.NodesToPlan));
            Assert.Equal(before.RootColumns(tree), after.RootColumns(tree));
            Assert.DoesNotContain(Owner, after.NodesToLoad);
            Assert.Empty(after.ReferencesByKind(ReferenceKind.ActionTargetNodes));
            Assert.True(before.IsRootOnly(tree));
            Assert.True(after.IsRootOnly(tree));
        }

        [Fact]
        public void A_create_per_row_makes_the_rule_traverse()
        {
            var tree = Tree();
            var refs = RuleReferences.Compute(RootOnlyGroups(), new[] { Block(), Create(Contacts) }, setTargets: tree);
            Assert.False(refs.IsRootOnly(tree));
        }

        [Fact]
        public void A_row_column_is_read_off_the_target_node_not_the_root()
        {
            var tree = TestTree.Tree(
                TestTree.Node(Root, "account", TableConfigType.RootTable, null),
                TestTree.Node(Contacts, "contact", TableConfigType.ChildTable, Root, "parentcustomerid"));
            var refs = RuleReferences.Compute(new List<ConditionGroup>(), new[] { SetUpdate() });
            Assert.DoesNotContain("fullname", refs.RootColumns(tree));
        }
    }
}
