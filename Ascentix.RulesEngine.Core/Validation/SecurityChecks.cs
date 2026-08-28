using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>The write right a System-context rule action effectively exercises.</summary>
    public enum SystemWriteRight
    {
        Create = 1,
        Write = 2,
        Delete = 3
    }

    /// <summary>
    /// Answers "does the publishing user hold this privilege at organization (Global) depth on
    /// this table?" Global is the only depth that matches what a System-context rule can actually do
    /// (its writes execute as SYSTEM against rows reached from arbitrary roots, org-wide).
    /// </summary>
    public interface IPublisherPrivilegeProvider
    {
        bool HasGlobalPrivilege(string tableLogicalName, SystemWriteRight right);
    }

    /// <summary>
    /// Publisher-relative security gate for System-context rules (SEC_* codes, deliberately a
    /// separate family from the rule-intrinsic STRUCT_/META_/TRAV_ codes: the same rule can be
    /// publishable by an admin and not by a BU-scoped Author). Contract: a rule never lets its
    /// publisher exceed what the publisher could do directly, so publishing a System-context rule
    /// carrying write actions requires the matching privilege at Global depth on each target table.
    ///
    /// Gated action shapes (evaluationcontext = System only; User-context rules are enforced by
    /// the platform at runtime and need no publish gate):
    ///   - CreateRecord (any target table)                          → Global Create
    ///   - UpdateRecord targeting a non-root node                   → Global Write
    ///   - UpdateRecord targeting the root, triggers incl. OnDelete → Global Write (no in-flight
    ///     Target exists on Delete, so the action falls through to the SYSTEM service-write path)
    ///   - DeleteRecord (any target, incl. root, never in-place)   → Global Delete
    /// Exempt: root-targeted UpdateRecord on rules without the OnDelete trigger. The in-place
    /// merge lands inside the saving user's own save and never consults the evaluation context.
    /// Only that structural mechanism earns exemption; trigger-based blanket exemptions would
    /// become latent holes if asx_RunRules ever gains an apply mode.
    /// </summary>
    public static class SecurityChecks
    {
        public const string CodeMissingPrivilege = "SEC_SYSWRITE_PRIV";
        public const string CodeRequirementInfo = "SEC_SYSWRITE_REQ";

        /// <summary>
        /// Evaluates the gate. Always emits an informational SEC_SYSWRITE_REQ warning per gated
        /// (table, right) so the editor can show the requirement to every caller; emits a blocking
        /// SEC_SYSWRITE_PRIV error only when <paramref name="privileges"/> is supplied and the
        /// user lacks the Global privilege. Pass the provider built for the publishing user
        /// (InitiatingUserId), because impersonated publishes must not launder the check.
        /// </summary>
        public static IReadOnlyList<ValidationIssue> Check(
            RuleForValidation model, IPublisherPrivilegeProvider privileges)
        {
            var issues = new List<ValidationIssue>();
            if (model == null) return issues;

            if (GetEvaluationContext(model.RuleEntity) != RuleEvaluationContext.System)
                return issues;

            var triggersIncludeDelete = HasTrigger(model.RuleEntity, RuleTrigger.OnDelete);

            foreach (var action in (model.Actions ?? new List<RuleAction>()).Where(a => a != null && a.IsActive))
            {
                string table;
                SystemWriteRight right;
                switch (action.ActionType)
                {
                    case ActionType.CreateRecord:
                        table = action.TargetTable;
                        right = SystemWriteRight.Create;
                        break;

                    case ActionType.UpdateRecord:
                        if (IsRootTargeted(action, model) && !triggersIncludeDelete)
                            continue; // in-place merge: structural exemption (see class remarks)
                        table = ResolveTargetTable(action, model);
                        right = SystemWriteRight.Write;
                        break;

                    case ActionType.DeleteRecord:
                        table = ResolveTargetTable(action, model);
                        right = SystemWriteRight.Delete;
                        break;

                    default:
                        continue; // non-write actions never escalate
                }

                if (string.IsNullOrWhiteSpace(table))
                    continue; // a missing target table is a STRUCT_/META_ problem, not a SEC_ one

                issues.Add(ValidationIssue.Warning(
                    CodeRequirementInfo,
                    $"Publishing requires organization-level (Global) {right} privilege on table '{table}' " +
                    "(System evaluation context with write actions). This requirement is checked against " +
                    "the publishing user at publish time.",
                    IssueTarget.Action(action.Id)));

                if (privileges != null && !privileges.HasGlobalPrivilege(table, right))
                {
                    issues.Add(ValidationIssue.Error(
                        CodeMissingPrivilege,
                        $"Publishing this System-context rule requires organization-level (Global) {right} " +
                        $"privilege on table '{table}', which the publishing user does not hold. " +
                        "Request the privilege, or change the rule to User evaluation context.",
                        IssueTarget.Action(action.Id)));
                }
            }

            return issues;
        }

        private static RuleEvaluationContext GetEvaluationContext(Entity rule)
        {
            var v = rule?.GetAttributeValue<OptionSetValue>(
                SchemaNames.Qualify(SchemaNames.Rule.EvaluationContext))?.Value;
            return v == (int)RuleEvaluationContext.System
                ? RuleEvaluationContext.System
                : RuleEvaluationContext.User;
        }

        private static bool HasTrigger(Entity rule, RuleTrigger trigger)
        {
            var triggers = rule?.GetAttributeValue<OptionSetValueCollection>(
                SchemaNames.Qualify(SchemaNames.Rule.Triggers));
            return triggers != null && triggers.Any(o => o != null && o.Value == (int)trigger);
        }

        // Update/Delete target the root when no target node is set, or when the target node's
        // config type is RootTable (mirrors WriteIntentResolver's RootTargeted semantics).
        private static bool IsRootTargeted(RuleAction action, RuleForValidation model)
        {
            if (!action.TargetNodeId.HasValue) return true;
            return model.Configs != null
                && model.Configs.TryGetNode(action.TargetNodeId.Value, out var node)
                && node != null
                && node.ConfigType == TableConfigType.RootTable;
        }

        private static string ResolveTargetTable(RuleAction action, RuleForValidation model)
        {
            if (action.TargetNodeId.HasValue
                && model.Configs != null
                && model.Configs.TryGetNode(action.TargetNodeId.Value, out var node)
                && node != null
                && !string.IsNullOrWhiteSpace(node.TableLogicalName))
                return node.TableLogicalName;
            return model.PrimaryTable;
        }
    }
}
