using System;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class SetActionsTests
    {
        private static readonly Guid Root = Guid.NewGuid(), Owner = Guid.NewGuid(), Contacts = Guid.NewGuid(), Tasks = Guid.NewGuid();

        private static TableConfigTree Tree() => TestTree.Tree(
            TestTree.Node(Root, "account", TableConfigType.RootTable, null),
            TestTree.Node(Owner, "systemuser", TableConfigType.LookupTable, Root),
            TestTree.Node(Contacts, "contact", TableConfigType.ChildTable, Root, "parentcustomerid"),
            TestTree.Node(Tasks, "task", TableConfigType.ChildTable, Contacts, "regardingobjectid"));

        private static RuleAction A(ActionType type, Guid? target) => new RuleAction { ActionType = type, TargetNodeId = target, IsActive = true };

        [Theory]
        [InlineData(ActionType.UpdateRecord)]
        [InlineData(ActionType.DeleteRecord)]
        [InlineData(ActionType.DeactivateRecord)]
        [InlineData(ActionType.CreateRecord)]
        public void A_write_action_on_a_collection_is_a_set_action(ActionType type)
        {
            Assert.True(SetActions.IsSetAction(A(type, Contacts), Tree()));
            Assert.True(SetActions.IsSetAction(A(type, Tasks), Tree())); // a collection under a collection
        }

        [Fact]
        public void A_write_action_on_a_single_record_node_is_not()
        {
            Assert.False(SetActions.IsSetAction(A(ActionType.UpdateRecord, Owner), Tree()));
            Assert.False(SetActions.IsSetAction(A(ActionType.UpdateRecord, Root), Tree()));
        }

        [Fact]
        public void A_create_with_a_single_record_target_is_not_a_set_action()
        {
            // A stale asx_targetnode left on a Create by an earlier Update edit: still one record.
            Assert.False(SetActions.IsSetAction(A(ActionType.CreateRecord, Owner), Tree()));
            Assert.False(SetActions.IsSetAction(A(ActionType.CreateRecord, null), Tree()));
        }

        [Fact]
        public void A_non_write_action_is_never_a_set_action()
            => Assert.False(SetActions.IsSetAction(A(ActionType.Block, Contacts), Tree()));

        [Fact]
        public void Unknown_nodes_are_not_collections()
            => Assert.False(Tree().IsCollection(Guid.NewGuid()));

        [Theory]
        [InlineData("opportunity")]
        [InlineData("Incident")]
        [InlineData("quote")]
        [InlineData("salesorder")]
        [InlineData("invoice")]
        public void State_message_tables_are_not_deactivatable(string table)
            => Assert.True(SetActions.IsNotDeactivatable(table));

        [Fact]
        public void Deactivate_is_a_server_write_that_maps_fields()
        {
            Assert.True(ActionDispatcher.IsServerAction(ActionType.DeactivateRecord));
            Assert.True(ActionDispatcher.IsWriteAction(ActionType.DeactivateRecord));
            Assert.True(ActionDispatcher.MapsFields(ActionType.DeactivateRecord));
            Assert.False(ActionDispatcher.MapsFields(ActionType.DeleteRecord));
            Assert.False(ActionDispatcher.IsWriteAction(ActionType.Block));
        }
    }
}
