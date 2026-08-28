using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Loaders
{
    // ─── Rule Action Loader ───────────────────────────────────────────────────

    /// <summary>
    /// Loads asx_ruleaction records for a set of rules and maps them to
    /// <see cref="RuleAction"/> POCOs, keyed by rule id.
    /// </summary>
    public class RuleActionLoader
    {
        private readonly IOrganizationService _service;

        private static readonly string ActionEntity = SchemaNames.Qualify(SchemaNames.RuleAction.Entity);
        private static readonly string RuleLookup = SchemaNames.Qualify(SchemaNames.RuleAction.Rule);
        private static readonly string ActionTypeField = SchemaNames.Qualify(SchemaNames.RuleAction.ActionType);
        private static readonly string FireOnField = SchemaNames.Qualify(SchemaNames.RuleAction.FireOn);
        private static readonly string TargetColumnField = SchemaNames.Qualify(SchemaNames.RuleAction.TargetColumn);
        private static readonly string ValueBoolField = SchemaNames.Qualify(SchemaNames.RuleAction.ValueBool);
        private static readonly string ApplyInverseField = SchemaNames.Qualify(SchemaNames.RuleAction.ApplyInverseWhenNotFired);
        private static readonly string MessageField = SchemaNames.Qualify(SchemaNames.RuleAction.Message);
        private static readonly string SeverityField = SchemaNames.Qualify(SchemaNames.RuleAction.Severity);
        private static readonly string TargetTableField = SchemaNames.Qualify(SchemaNames.RuleAction.TargetTable);
        private static readonly string TargetNodeField = SchemaNames.Qualify(SchemaNames.RuleAction.TargetNode);
        private static readonly string FieldMappingField = SchemaNames.Qualify(SchemaNames.RuleAction.FieldMapping);
        private static readonly string OrderField = SchemaNames.Qualify(SchemaNames.RuleAction.Order);
        private static readonly string IsActiveField = SchemaNames.Qualify(SchemaNames.RuleAction.IsActive);

        private static readonly string LocalizedMessageEntity = SchemaNames.Qualify(SchemaNames.LocalizedMessage.Entity);
        private static readonly string LmRuleActionLookup = SchemaNames.Qualify(SchemaNames.LocalizedMessage.RuleAction);
        private static readonly string LmLanguageField = SchemaNames.Qualify(SchemaNames.LocalizedMessage.LanguageCode);
        private static readonly string LmMessageField = SchemaNames.Qualify(SchemaNames.LocalizedMessage.Message);

        public RuleActionLoader(IOrganizationService service)
        {
            _service = service;
        }

        public Dictionary<Guid, List<RuleAction>> LoadActionsByRule(IEnumerable<Guid> ruleIds)
        {
            var result = new Dictionary<Guid, List<RuleAction>>();
            var ids = ruleIds?.Distinct().Cast<object>().ToArray() ?? new object[0];
            if (ids.Length == 0) return result;

            var query = new QueryExpression(ActionEntity) { ColumnSet = new ColumnSet(true) };
            query.Criteria.AddCondition(RuleLookup, ConditionOperator.In, ids);

            foreach (var e in _service.RetrieveMultiple(query).Entities)
            {
                var ruleRef = e.GetAttributeValue<EntityReference>(RuleLookup);
                if (ruleRef == null) continue;

                if (!result.TryGetValue(ruleRef.Id, out var list))
                {
                    list = new List<RuleAction>();
                    result[ruleRef.Id] = list;
                }
                list.Add(Map(e, ruleRef.Id));
            }

            LoadLocalizedMessages(result.Values.SelectMany(v => v).ToList());
            return result;
        }

        private RuleAction Map(Entity e, Guid ruleId)
        {
            return new RuleAction
            {
                Id = e.Id,
                RuleId = ruleId,
                ActionType = (ActionType)(e.GetAttributeValue<OptionSetValue>(ActionTypeField)?.Value ?? 0),
                FireOn = (ActionFireOn)(e.GetAttributeValue<OptionSetValue>(FireOnField)?.Value ?? 0),
                TargetColumn = e.GetAttributeValue<string>(TargetColumnField),
                ValueBool = e.GetAttributeValue<bool>(ValueBoolField),
                ApplyInverseWhenNotFired = e.GetAttributeValue<bool>(ApplyInverseField),
                Message = e.GetAttributeValue<string>(MessageField),
                Severity = e.GetAttributeValue<OptionSetValue>(SeverityField) is OptionSetValue sev
                    ? (Severity?)sev.Value : null,
                TargetTable = e.GetAttributeValue<string>(TargetTableField),
                TargetNodeId = e.GetAttributeValue<EntityReference>(TargetNodeField)?.Id,
                FieldMapping = e.GetAttributeValue<string>(FieldMappingField),
                Order = e.GetAttributeValue<int>(OrderField),
                IsActive = e.GetAttributeValue<bool>(IsActiveField)
            };
        }

        private void LoadLocalizedMessages(List<RuleAction> actions)
        {
            if (actions.Count == 0) return;
            var actionIds = actions.Select(a => (object)a.Id).ToArray();

            var query = new QueryExpression(LocalizedMessageEntity)
            {
                ColumnSet = new ColumnSet(LmRuleActionLookup, LmLanguageField, LmMessageField)
            };
            query.Criteria.AddCondition(LmRuleActionLookup, ConditionOperator.In, actionIds);

            var byActionId = actions.ToDictionary(a => a.Id);
            foreach (var e in _service.RetrieveMultiple(query).Entities)
            {
                var actionRef = e.GetAttributeValue<EntityReference>(LmRuleActionLookup);
                if (actionRef == null || !byActionId.TryGetValue(actionRef.Id, out var action)) continue;

                var lcid = e.GetAttributeValue<int>(LmLanguageField);
                if (lcid != 0)
                    action.LocalizedMessages[lcid] = e.GetAttributeValue<string>(LmMessageField);
            }
        }
    }
}
