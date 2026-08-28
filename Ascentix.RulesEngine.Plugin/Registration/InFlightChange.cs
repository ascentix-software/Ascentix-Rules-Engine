using System;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin.Registration
{
    public enum ChangeEntity { Rule, Action, Other }
    public enum ChangeMessage { Create, Update, Delete, Other }

    /// <summary>
    /// The triggering rule/action change, as the transaction WILL commit it, read from
    /// the Target (overlaying the pre-image). The registration path overlays this onto the
    /// committed rule/action set so a pre-operation reconcile sees its own in-flight change.
    /// </summary>
    public class InFlightChange
    {
        private static readonly string RuleEntity = SchemaNames.Qualify(SchemaNames.Rule.Entity);
        private static readonly string ActionEntity = SchemaNames.Qualify(SchemaNames.RuleAction.Entity);
        private static readonly string RuleTableField = SchemaNames.Qualify(SchemaNames.Rule.TableLogicalName);
        private static readonly string ActionRuleField = SchemaNames.Qualify(SchemaNames.RuleAction.Rule);

        public ChangeEntity Entity { get; private set; }
        public ChangeMessage Message { get; private set; }
        public Guid RecordId { get; private set; }
        public Entity Target { get; private set; }
        public Entity PreImage { get; private set; }
        public Guid? ParentRuleId { get; private set; }
        public string EffectiveTable { get; private set; }

        public int? TargetStatus =>
            Target != null && Target.Contains("statuscode")
                ? Target.GetAttributeValue<OptionSetValue>("statuscode")?.Value
                : (int?)null;

        public bool IsRulePublish =>
            Entity == ChangeEntity.Rule
            && (Message == ChangeMessage.Create || Message == ChangeMessage.Update)
            && TargetStatus == (int)RuleStatus.Published;

        public bool IsRuleUnpublish =>
            Entity == ChangeEntity.Rule
            && Message == ChangeMessage.Update
            && TargetStatus.HasValue
            && TargetStatus.Value != (int)RuleStatus.Published;

        public bool IsRuleDelete =>
            Entity == ChangeEntity.Rule && Message == ChangeMessage.Delete;

        public static InFlightChange From(IPluginExecutionContext context)
        {
            var change = new InFlightChange
            {
                Entity = ResolveEntity(context.PrimaryEntityName),
                Message = ResolveMessage(context.MessageName)
            };

            context.InputParameters.TryGetValue("Target", out var target);
            change.Target = target as Entity;
            var targetRef = target as EntityReference;

            Entity preImage = null;
            context.PreEntityImages?.TryGetValue("PreImage", out preImage);
            change.PreImage = preImage;

            change.RecordId = change.Target?.Id ?? targetRef?.Id ?? preImage?.Id ?? Guid.Empty;

            if (change.Entity == ChangeEntity.Rule)
            {
                change.EffectiveTable =
                    change.Target?.GetAttributeValue<string>(RuleTableField)
                    ?? preImage?.GetAttributeValue<string>(RuleTableField);
            }
            else if (change.Entity == ChangeEntity.Action)
            {
                var ruleRef = change.Target?.GetAttributeValue<EntityReference>(ActionRuleField)
                              ?? preImage?.GetAttributeValue<EntityReference>(ActionRuleField);
                change.ParentRuleId = ruleRef?.Id;
            }

            return change;
        }

        private static ChangeEntity ResolveEntity(string entity)
        {
            if (string.Equals(entity, RuleEntity, StringComparison.OrdinalIgnoreCase)) return ChangeEntity.Rule;
            if (string.Equals(entity, ActionEntity, StringComparison.OrdinalIgnoreCase)) return ChangeEntity.Action;
            return ChangeEntity.Other;
        }

        private static ChangeMessage ResolveMessage(string message)
        {
            if (string.Equals(message, "Create", StringComparison.OrdinalIgnoreCase)) return ChangeMessage.Create;
            if (string.Equals(message, "Update", StringComparison.OrdinalIgnoreCase)) return ChangeMessage.Update;
            if (string.Equals(message, "Delete", StringComparison.OrdinalIgnoreCase)) return ChangeMessage.Delete;
            return ChangeMessage.Other;
        }
    }
}
