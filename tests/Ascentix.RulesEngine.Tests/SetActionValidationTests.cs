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
    public class SetActionValidationTests
    {
        private static readonly Guid Root = Guid.NewGuid(), Owner = Guid.NewGuid(), Contacts = Guid.NewGuid(),
            Tasks = Guid.NewGuid(), Opps = Guid.NewGuid(), Notes = Guid.NewGuid();

        private sealed class Flags : IAttributeFlagsProvider
        {
            private static readonly HashSet<string> Known = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "account.name", "account.description", "contact.donotbulkemail", "contact.statecode", "contact.fullname",
                "contact.contactid", "contact.description", "task.subject", "task.regardingobjectid", "task.statecode",
                "task.statuscode", "opportunity.statecode", "systemuser.fullname",
            };
            public bool TableExists(string table) => true;
            public AttributeFlags GetFlags(string table, string column) =>
                Known.Contains(table + "." + column)
                    ? new AttributeFlags { IsValidForCreate = true, IsValidForUpdate = true, IsValidForRead = true, Type = AttributeTypeCode.String }
                    : null;
        }

        private static RuleForValidation Model(params RuleAction[] actions)
        {
            var group = new ConditionGroup
            {
                Id = Guid.NewGuid(), LogicalOperator = LogicalOperator.And, ChildGroups = new List<ConditionGroup>(),
                Conditions = new List<RuleCondition> { new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = Root,
                    ConditionType = ConditionType.FieldComparison, ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.IsNotNull } },
            };
            return new RuleForValidation
            {
                RuleId = Guid.NewGuid(), PrimaryTable = "account",
                Groups = new List<ConditionGroup> { group },
                Configs = TestTree.RawTree(
                    TestTree.Node(Root, "account", TableConfigType.RootTable, null),
                    new TableConfig { Id = Owner, TableLogicalName = "systemuser", ConfigType = TableConfigType.LookupTable, ParentTableId = Root,
                        LookupColumnLogicalName = "ownerid", LookupTargetIdAttribute = "systemuserid" },
                    TestTree.Node(Contacts, "contact", TableConfigType.ChildTable, Root, "parentcustomerid"),
                    TestTree.Node(Tasks, "task", TableConfigType.ChildTable, Contacts, "regardingobjectid"),
                    TestTree.Node(Opps, "opportunity", TableConfigType.ChildTable, Root, "parentaccountid"),
                    TestTree.Node(Notes, "sample_note", TableConfigType.ChildTable, Root, "sample_accountid")),
                Actions = actions.ToList(),
            };
        }

        private static RuleAction Act(ActionType type, Guid? target, string mapping = null, NodeFilterGroup filter = null, string table = null) => new RuleAction
        {
            Id = Guid.NewGuid(), ActionType = type, FireOn = ActionFireOn.OnMatch, IsActive = true, TargetNodeId = target,
            TargetTable = table, FieldMapping = mapping, RowFilter = filter,
        };

        private static NodeFilterGroup Filter(Guid node, string field = "statecode") => new NodeFilterGroup
        {
            TableConfigNodeId = node, LogicalOperator = LogicalOperator.And,
            Criteria = { new NodeFilterCriterion { FieldName = field, Operator = "eq", Value = "0" } },
        };

        private static List<string> Codes(RuleForValidation m) => RuleValidator.Validate(m, new Flags()).Issues.Select(i => i.Code).ToList();

        private const string BulkEmail = "[{\"target\":\"donotbulkemail\",\"source\":\"literal\",\"value\":true}]";

        [Fact]
        public void A_set_update_on_a_collection_is_valid()
            => Assert.Empty(Codes(Model(Act(ActionType.UpdateRecord, Contacts, BulkEmail, Filter(Contacts)))));

        [Fact]
        public void A_node_source_on_a_collection_is_still_not_single_cardinality()
        {
            var mapping = "[{\"target\":\"description\",\"source\":\"node\",\"node\":\"" + Contacts + "\",\"column\":\"fullname\"}]";
            Assert.Contains("TRAV_NOT_SINGLE_CARDINALITY", Codes(Model(Act(ActionType.UpdateRecord, Root, mapping))));
        }

        [Fact]
        public void A_rows_filter_on_a_single_record_action_is_rejected()
            => Assert.Contains("STRUCT_ACTION_FILTER_TARGET", Codes(Model(Act(ActionType.UpdateRecord, Owner,
                "[{\"target\":\"fullname\",\"source\":\"literal\",\"value\":\"x\"}]", Filter(Owner, "fullname")))));

        [Fact]
        public void A_rows_filter_on_another_node_is_rejected()
            => Assert.Contains("STRUCT_ACTION_FILTER_TARGET", Codes(Model(Act(ActionType.UpdateRecord, Contacts, BulkEmail, Filter(Tasks)))));

        [Fact]
        public void A_row_source_on_a_single_record_action_is_rejected()
        {
            Assert.Contains("STRUCT_ROW_SOURCE_NOT_SET", Codes(Model(Act(ActionType.UpdateRecord, Root,
                "[{\"target\":\"description\",\"source\":\"row\",\"column\":\"fullname\"}]"))));
            Assert.Contains("STRUCT_ROW_SOURCE_NOT_SET", Codes(Model(Act(ActionType.CreateRecord, null,
                "[{\"target\":\"subject\",\"source\":\"template\",\"template\":\"x {row.fullname}\"}]", table: "task"))));
        }

        [Fact]
        public void Create_per_row_with_row_sources_is_valid()
        {
            var mapping = "[{\"target\":\"regardingobjectid\",\"source\":\"row\",\"column\":\"contactid\"}," +
                          "{\"target\":\"subject\",\"source\":\"template\",\"template\":\"Follow up {row.fullname}\"}]";
            Assert.Empty(Codes(Model(Act(ActionType.CreateRecord, Contacts, mapping, table: "task"))));
        }

        [Fact]
        public void A_missing_row_column_is_reported()
            => Assert.Contains("META_COLUMN_NOT_FOUND", Codes(Model(Act(ActionType.CreateRecord, Contacts,
                "[{\"target\":\"subject\",\"source\":\"row\",\"column\":\"ghost\"}]", table: "task"))));

        [Fact]
        public void A_deactivate_mapping_other_than_status_reason_is_rejected()
        {
            var codes = Codes(Model(Act(ActionType.DeactivateRecord, Tasks, "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"x\"}]")));
            Assert.Contains("STRUCT_DEACTIVATE_MAPPING", codes);
            Assert.DoesNotContain("STRUCT_DEACTIVATE_MAPPING", Codes(Model(Act(ActionType.DeactivateRecord, Tasks,
                "[{\"target\":\"statuscode\",\"source\":\"literal\",\"value\":5}]"))));
        }

        [Fact]
        public void A_deactivate_without_a_target_is_missing_a_field()
            => Assert.Contains("STRUCT_MISSING_FIELD", Codes(Model(Act(ActionType.DeactivateRecord, null))));

        [Fact]
        public void Deactivating_a_state_message_table_or_a_table_without_status_is_rejected()
        {
            Assert.Contains("META_TABLE_NOT_DEACTIVATABLE", Codes(Model(Act(ActionType.DeactivateRecord, Opps))));
            Assert.Contains("META_TABLE_NOT_DEACTIVATABLE", Codes(Model(Act(ActionType.DeactivateRecord, Notes))));
            Assert.DoesNotContain("META_TABLE_NOT_DEACTIVATABLE", Codes(Model(Act(ActionType.DeactivateRecord, Tasks))));
        }

        [Fact]
        public void Apply_to_previous_on_a_set_target_is_rejected()
        {
            var action = Act(ActionType.UpdateRecord, Contacts, BulkEmail);
            action.ApplyToPrevious = true;
            Assert.Contains("STRUCT_APPLY_PREVIOUS_TARGET", Codes(Model(action)));
        }

        [Fact]
        public void A_rows_filter_column_is_checked_against_the_target_table()
            => Assert.Contains("META_FILTER_COLUMN_NOT_FOUND", Codes(Model(Act(ActionType.UpdateRecord, Contacts, BulkEmail, Filter(Contacts, "ghost")))));

        [Fact]
        public void A_rows_filter_exists_collection_must_be_a_collection()
        {
            var filter = new NodeFilterGroup
            {
                TableConfigNodeId = Contacts, LogicalOperator = LogicalOperator.And,
                Criteria = { new NodeFilterCriterion { Kind = CriterionKind.Exists, CollectionNodeId = Owner, MaxCount = 0 } },
            };
            Assert.Contains("TRAV_EXISTS_NOT_COLLECTION", Codes(Model(Act(ActionType.UpdateRecord, Contacts, BulkEmail, filter))));
        }

        // A {row.…} token exists only for a set action; a Show Message action is never a set
        // action (SetActions.IsSetAction only recognizes Create/Update/Delete/Deactivate), so a
        // {row.…} token in its Message would otherwise reach TemplateRenderer.Render at runtime
        // and throw "…can only be used by an action that writes a set of rows." Publish must
        // catch it instead.
        [Fact]
        public void A_row_token_in_a_show_message_action_is_rejected()
        {
            var action = new RuleAction
            {
                Id = Guid.NewGuid(), ActionType = ActionType.ShowMessage, FireOn = ActionFireOn.OnMatch, IsActive = true,
                Message = "Hello {row.fullname}",
            };
            Assert.Contains("STRUCT_ROW_SOURCE_NOT_SET", Codes(Model(action)));
        }
    }
}
