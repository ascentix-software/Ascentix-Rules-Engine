using System;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class PreviousParentTests
    {
        internal static readonly Guid RootId = Guid.NewGuid();
        internal static readonly Guid ContactId = Guid.NewGuid();
        internal static readonly Guid AccountId = Guid.NewGuid();
        internal static readonly Guid LinesId = Guid.NewGuid();
        internal static readonly Guid LineProductId = Guid.NewGuid();

        // opportunity (root) → contact (lookup) → account (lookup); opportunity → lines (child) → product (lookup)
        internal static TableConfigTree Tree() => TestTree.Tree(
            new TableConfig { Id = RootId, TableLogicalName = "opportunity", ConfigType = TableConfigType.RootTable },
            new TableConfig { Id = ContactId, TableLogicalName = "contact", ConfigType = TableConfigType.LookupTable,
                ParentTableId = RootId, LookupColumnLogicalName = "parentcontactid", LookupTargetIdAttribute = "contactid" },
            new TableConfig { Id = AccountId, TableLogicalName = "account", ConfigType = TableConfigType.LookupTable,
                ParentTableId = ContactId, LookupColumnLogicalName = "parentcustomerid", LookupTargetIdAttribute = "accountid" },
            new TableConfig { Id = LinesId, TableLogicalName = "opportunityproduct", ConfigType = TableConfigType.ChildTable,
                ParentTableId = RootId, ChildLinkField = "opportunityid" },
            new TableConfig { Id = LineProductId, TableLogicalName = "product", ConfigType = TableConfigType.LookupTable,
                ParentTableId = LinesId, LookupColumnLogicalName = "productid", LookupTargetIdAttribute = "productid" });

        internal static RuleAction Update(Guid target, bool tick = true, bool active = true) => new RuleAction
        {
            Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, TargetNodeId = target,
            ApplyToPrevious = tick, IsActive = active, FireOn = ActionFireOn.OnMatch,
        };

        [Fact]
        public void The_root_level_lookup_is_found_from_itself_and_from_below()
        {
            var tree = Tree();
            Assert.Equal(ContactId, PreviousParent.RootLookupOf(tree, ContactId).Id);
            Assert.Equal(ContactId, PreviousParent.RootLookupOf(tree, AccountId).Id);
        }

        [Fact]
        public void The_root_a_collection_and_a_lookup_under_a_collection_have_none()
        {
            var tree = Tree();
            Assert.Null(PreviousParent.RootLookupOf(tree, RootId));
            Assert.Null(PreviousParent.RootLookupOf(tree, LinesId));
            Assert.Null(PreviousParent.RootLookupOf(tree, LineProductId));
            Assert.Null(PreviousParent.RootLookupOf(tree, Guid.NewGuid()));
        }

        [Fact]
        public void Only_a_ticked_active_update_in_a_lookup_branch_takes_part()
        {
            var tree = Tree();
            Assert.Equal(ContactId, PreviousParent.LookupFor(Update(AccountId), tree).Id);
            Assert.Null(PreviousParent.LookupFor(Update(ContactId, tick: false), tree));
            Assert.Null(PreviousParent.LookupFor(Update(ContactId, active: false), tree));
            Assert.Null(PreviousParent.LookupFor(Update(RootId), tree));

            var delete = Update(ContactId);
            delete.ActionType = ActionType.DeleteRecord;
            Assert.Null(PreviousParent.LookupFor(delete, tree));
        }
    }
}
