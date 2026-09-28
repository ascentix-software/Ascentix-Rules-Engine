using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
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

        private static Entity Opp(Guid? contact) =>
            new Entity("opportunity", Guid.NewGuid()) { ["parentcontactid"] = contact.HasValue ? new EntityReference("contact", contact.Value) : null };

        [Fact]
        public void A_changed_lookup_with_a_ticked_action_is_reported_with_its_previous_value()
        {
            var ana = Guid.NewGuid();
            var ben = Guid.NewGuid();
            var saved = Opp(ana);
            var overlay = new Entity("opportunity", saved.Id) { ["parentcontactid"] = new EntityReference("contact", ben) };

            var changed = Assert.Single(PreviousParent.Changed(Tree(), new[] { Update(ContactId), Update(AccountId) }, saved, overlay));
            Assert.Equal(ContactId, changed.Lookup.Id);
            Assert.Equal(ana, changed.Previous.Id);
        }

        [Fact]
        public void Nothing_is_reported_without_a_real_change_or_a_previous_value()
        {
            var ana = Guid.NewGuid();
            var tree = Tree();
            var actions = new[] { Update(ContactId) };

            // Lookup not in the Target (some other column changed).
            Assert.Empty(PreviousParent.Changed(tree, actions, Opp(ana), new Entity("opportunity", Guid.NewGuid()) { ["name"] = "x" }));
            // Same value written again.
            Assert.Empty(PreviousParent.Changed(tree, actions, Opp(ana),
                new Entity("opportunity", Guid.NewGuid()) { ["parentcontactid"] = new EntityReference("contact", ana) }));
            // No previous value.
            Assert.Empty(PreviousParent.Changed(tree, actions, Opp(null),
                new Entity("opportunity", Guid.NewGuid()) { ["parentcontactid"] = new EntityReference("contact", ana) }));
            // Nothing ticked.
            Assert.Empty(PreviousParent.Changed(tree, new[] { Update(ContactId, tick: false) }, Opp(ana),
                new Entity("opportunity", Guid.NewGuid()) { ["parentcontactid"] = null }));
            // No saved record (Create).
            Assert.Empty(PreviousParent.Changed(tree, actions, null,
                new Entity("opportunity", Guid.NewGuid()) { ["parentcontactid"] = null }));
        }

        [Fact]
        public void Two_lookups_changing_in_one_save_give_two_runs()
        {
            var ownerCfg = new TableConfig { Id = Guid.NewGuid(), TableLogicalName = "systemuser", ConfigType = TableConfigType.LookupTable,
                ParentTableId = RootId, LookupColumnLogicalName = "ownerid", LookupTargetIdAttribute = "systemuserid" };
            var tree = TestTree.Tree(Tree().Node(RootId), Tree().Node(ContactId), ownerCfg);
            var ana = Guid.NewGuid();
            var oldOwner = Guid.NewGuid();
            var saved = Opp(ana);
            saved["ownerid"] = new EntityReference("systemuser", oldOwner);
            var overlay = new Entity("opportunity", saved.Id)
            {
                ["parentcontactid"] = new EntityReference("contact", Guid.NewGuid()),
                ["ownerid"] = new EntityReference("systemuser", Guid.NewGuid()),
            };

            var changed = PreviousParent.Changed(tree, new[] { Update(ContactId), Update(ownerCfg.Id) }, saved, overlay);

            Assert.Equal(2, changed.Count);
            Assert.Contains(changed, c => c.Lookup.Id == ContactId && c.Previous.Id == ana);
            Assert.Contains(changed, c => c.Lookup.Id == ownerCfg.Id && c.Previous.Id == oldOwner);
        }

        [Fact]
        public void Clearing_the_lookup_is_a_change_to_the_previous_value()
        {
            var ana = Guid.NewGuid();
            var overlay = new Entity("opportunity", Guid.NewGuid()) { ["parentcontactid"] = null };
            Assert.Equal(ana, Assert.Single(PreviousParent.Changed(Tree(), new[] { Update(ContactId) }, Opp(ana), overlay)).Previous.Id);
        }

        [Fact]
        public void The_run_2_root_points_the_lookup_at_its_previous_value_and_keeps_the_rest()
        {
            var ben = new EntityReference("contact", Guid.NewGuid());
            var root = new Entity("opportunity", Guid.NewGuid()) { ["parentcontactid"] = ben, ["estimatedvalue"] = new Money(10m) };
            var ana = new EntityReference("contact", Guid.NewGuid());
            var lookup = Tree().Node(ContactId);

            var previous = PreviousParent.RootFor(root, new ChangedLookup(lookup, ana));

            Assert.Equal(ana.Id, previous.GetAttributeValue<EntityReference>("parentcontactid").Id);
            Assert.Equal(10m, previous.GetAttributeValue<Money>("estimatedvalue").Value);
            Assert.Equal(ben.Id, root.GetAttributeValue<EntityReference>("parentcontactid").Id); // original untouched
        }
    }
}
