using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Validation;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// The publisher-relative SEC gate for System-context rules (SEC_SYSWRITE_PRIV /
    /// SEC_SYSWRITE_REQ). Covers the gated-action enumeration (including the root-in-place
    /// exemption and its OnDelete trap) and the always-emit-REQ / error-only-without-privilege
    /// split.
    /// </summary>
    public class SecurityChecksTests
    {
        private class FakePrivileges : IPublisherPrivilegeProvider
        {
            public HashSet<string> Grants = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public bool HasGlobalPrivilege(string table, SystemWriteRight right)
                => Grants.Contains(table + ":" + right);
        }

        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid ChildId = Guid.NewGuid();

        private static Entity RuleEntity(RuleEvaluationContext ctx, params RuleTrigger[] triggers)
        {
            var e = new Entity(SchemaNames.Qualify(SchemaNames.Rule.Entity), Guid.NewGuid());
            e[SchemaNames.Qualify(SchemaNames.Rule.EvaluationContext)] = new OptionSetValue((int)ctx);
            e[SchemaNames.Qualify(SchemaNames.Rule.Triggers)] =
                new OptionSetValueCollection(triggers.Select(t => new OptionSetValue((int)t)).ToList());
            return e;
        }

        private static RuleForValidation Model(Entity rule, params RuleAction[] actions)
        {
            return new RuleForValidation
            {
                RuleId = rule.Id,
                RuleEntity = rule,
                PrimaryTable = "sample_order",
                Configs = TestTree.RawTree(
                    new TableConfig { Id = RootId, TableLogicalName = "sample_order", ConfigType = TableConfigType.RootTable },
                    new TableConfig { Id = ChildId, TableLogicalName = "sample_orderline", ConfigType = TableConfigType.ChildTable }),
                Actions = actions.ToList(),
            };
        }

        private static RuleAction Action(ActionType type, string targetTable = null, Guid? targetNodeId = null, bool active = true)
            => new RuleAction { Id = Guid.NewGuid(), ActionType = type, TargetTable = targetTable, TargetNodeId = targetNodeId, IsActive = active };

        // ── scope: when the gate applies at all ─────────────────────────────────────────────

        [Fact]
        public void User_context_rule_with_write_actions_is_not_gated()
        {
            var model = Model(RuleEntity(RuleEvaluationContext.User, RuleTrigger.OnCreate),
                Action(ActionType.CreateRecord, targetTable: "account"));
            var issues = SecurityChecks.Check(model, new FakePrivileges());
            Assert.Empty(issues);
        }

        [Fact]
        public void Non_write_actions_never_gate()
        {
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnCreate),
                Action(ActionType.Block), Action(ActionType.ShowMessage), Action(ActionType.SetVisible));
            Assert.Empty(SecurityChecks.Check(model, new FakePrivileges()));
        }

        [Fact]
        public void Inactive_write_actions_are_ignored()
        {
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnCreate),
                Action(ActionType.CreateRecord, targetTable: "account", active: false));
            Assert.Empty(SecurityChecks.Check(model, new FakePrivileges()));
        }

        // ── the enumeration ─────────────────────────────────────────────────────────────────

        [Fact]
        public void CreateRecord_requires_global_create_on_target_table()
        {
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnCreate),
                Action(ActionType.CreateRecord, targetTable: "account"));

            var denied = SecurityChecks.Check(model, new FakePrivileges());
            Assert.Contains(denied, i => i.Code == SecurityChecks.CodeMissingPrivilege && i.Message.Contains("account") && i.Message.Contains("Create"));

            var granted = SecurityChecks.Check(model, new FakePrivileges { Grants = { "account:Create" } });
            Assert.DoesNotContain(granted, i => i.Code == SecurityChecks.CodeMissingPrivilege);
        }

        [Fact]
        public void Root_targeted_update_without_OnDelete_is_exempt()
        {
            // In-place merge: lands inside the saving user's own save; never consults the context.
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnCreate, RuleTrigger.OnUpdate),
                Action(ActionType.UpdateRecord, targetNodeId: RootId));
            Assert.Empty(SecurityChecks.Check(model, new FakePrivileges()));
        }

        [Fact]
        public void Root_targeted_update_with_no_target_node_is_exempt_without_OnDelete()
        {
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnUpdate),
                Action(ActionType.UpdateRecord));
            Assert.Empty(SecurityChecks.Check(model, new FakePrivileges()));
        }

        [Fact]
        public void Root_targeted_update_with_OnDelete_trigger_is_gated()
        {
            // The OnDelete trap: no in-flight Target exists on Delete, so the action falls through
            // to the SYSTEM service-write path. Global Write on the root table is required.
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnDelete),
                Action(ActionType.UpdateRecord, targetNodeId: RootId));

            var denied = SecurityChecks.Check(model, new FakePrivileges());
            Assert.Contains(denied, i => i.Code == SecurityChecks.CodeMissingPrivilege && i.Message.Contains("sample_order") && i.Message.Contains("Write"));
        }

        [Fact]
        public void Non_root_update_is_gated_on_the_nodes_table()
        {
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnUpdate),
                Action(ActionType.UpdateRecord, targetNodeId: ChildId));

            var denied = SecurityChecks.Check(model, new FakePrivileges());
            Assert.Contains(denied, i => i.Code == SecurityChecks.CodeMissingPrivilege && i.Message.Contains("sample_orderline"));

            var granted = SecurityChecks.Check(model, new FakePrivileges { Grants = { "sample_orderline:Write" } });
            Assert.DoesNotContain(granted, i => i.Code == SecurityChecks.CodeMissingPrivilege);
        }

        [Fact]
        public void DeleteRecord_is_always_gated_even_on_root()
        {
            // Root delete is never in-place (IsRootInPlace requires the Update operation).
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnUpdate),
                Action(ActionType.DeleteRecord, targetNodeId: RootId));

            var denied = SecurityChecks.Check(model, new FakePrivileges());
            Assert.Contains(denied, i => i.Code == SecurityChecks.CodeMissingPrivilege && i.Message.Contains("Delete"));
        }

        // ── REQ / PRIV split ────────────────────────────────────────────────────────────────

        [Fact]
        public void Requirement_warning_is_always_emitted_for_gated_actions()
        {
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnCreate),
                Action(ActionType.CreateRecord, targetTable: "account"));

            var granted = SecurityChecks.Check(model, new FakePrivileges { Grants = { "account:Create" } });
            Assert.Contains(granted, i => i.Code == SecurityChecks.CodeRequirementInfo && i.Severity == IssueSeverity.Warning);
            // A privileged caller still sees the requirement, but nothing blocks.
            Assert.True(ValidationReport.From(granted).IsValid);
        }

        [Fact]
        public void Null_provider_emits_requirement_but_never_blocks()
        {
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnCreate),
                Action(ActionType.CreateRecord, targetTable: "account"));
            var issues = SecurityChecks.Check(model, null);
            Assert.Contains(issues, i => i.Code == SecurityChecks.CodeRequirementInfo);
            Assert.DoesNotContain(issues, i => i.Code == SecurityChecks.CodeMissingPrivilege);
        }

        [Fact]
        public void Issues_target_the_offending_action()
        {
            var action = Action(ActionType.CreateRecord, targetTable: "account");
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnCreate), action);
            var issues = SecurityChecks.Check(model, new FakePrivileges());
            Assert.All(issues, i => Assert.Equal(action.Id, i.Target.Id));
            Assert.All(issues, i => Assert.Equal(TargetKind.Action, i.Target.Kind));
        }

        [Fact]
        public void Missing_target_table_is_not_a_sec_issue()
        {
            // A CreateRecord without a target table is a STRUCT_/META_ problem; SEC stays silent.
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnCreate),
                Action(ActionType.CreateRecord, targetTable: null));
            Assert.Empty(SecurityChecks.Check(model, new FakePrivileges()));
        }

        [Fact]
        public void Multiple_gated_actions_each_get_their_own_issues()
        {
            var model = Model(RuleEntity(RuleEvaluationContext.System, RuleTrigger.OnDelete),
                Action(ActionType.CreateRecord, targetTable: "account"),
                Action(ActionType.DeleteRecord, targetNodeId: ChildId));

            var denied = SecurityChecks.Check(model, new FakePrivileges());
            Assert.Equal(2, denied.Count(i => i.Code == SecurityChecks.CodeMissingPrivilege));
            Assert.Equal(2, denied.Count(i => i.Code == SecurityChecks.CodeRequirementInfo));
        }
    }
}
