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
        private static readonly string ApplyToPreviousField = SchemaNames.Qualify(SchemaNames.RuleAction.ApplyToPrevious);
        private static readonly string NameField = SchemaNames.Qualify(SchemaNames.PrimaryName);
        private static readonly string FilterGroupActionLookup = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.RuleAction);

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
            LoadRowFilters(result.Values.SelectMany(v => v).ToList());
            LoadConditions(result.Values.SelectMany(v => v).ToList());
            return result;
        }

        private RuleAction Map(Entity e, Guid ruleId)
        {
            return new RuleAction
            {
                Id = e.Id,
                RuleId = ruleId,
                Name = e.GetAttributeValue<string>(NameField),
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
                IsActive = e.GetAttributeValue<bool>(IsActiveField),
                ApplyToPrevious = e.GetAttributeValue<bool>(ApplyToPreviousField)
            };
        }

        // Every group of an action's Rows filter carries asx_ruleaction (root and nested), as condition
        // filters carry asx_conditiongroup; EXISTS sub-filters hang off their criterion and are wired by
        // NodeFilterGraphLoader. One top-level group per action.
        private void LoadRowFilters(List<RuleAction> actions)
        {
            if (actions.Count == 0) return;
            var query = new QueryExpression(NodeFilterGraphLoader.FilterGroupEntity) { ColumnSet = new ColumnSet(true) };
            query.Criteria.AddCondition(FilterGroupActionLookup, ConditionOperator.In, actions.Select(a => (object)a.Id).ToArray());
            var groups = _service.RetrieveMultiple(query).Entities.ToList();
            if (groups.Count == 0) return;

            NodeFilterGraphLoader.Wire(_service, groups);
            var byId = actions.ToDictionary(a => a.Id);
            var mapper = new ConditionGroupMapper();
            foreach (var root in groups.Where(g => g.GetAttributeValue<EntityReference>(NodeFilterGraphLoader.FilterGroupParentLookup) == null))
            {
                var actionId = root.GetAttributeValue<EntityReference>(FilterGroupActionLookup).Id;
                if (!byId.TryGetValue(actionId, out var action)) continue;
                if (action.RowFilter != null)
                    throw new InvalidPluginExecutionException(
                        $"Action {actionId} owns more than one Rows filter group; an action may own only one.");
                action.RowFilter = mapper.MapRowFilter(root, actionId);
            }
        }

        // Every node of an action's "Fires when" tree carries asx_ruleaction, so two In queries load every tree.
        // Runs against SnapshotService for published rules (Equal/In only, no links).
        private void LoadConditions(List<RuleAction> actions)
        {
            if (actions.Count == 0) return;
            var groupQuery = new QueryExpression(SchemaNames.Qualify(SchemaNames.ActionConditionGroup.Entity)) { ColumnSet = new ColumnSet(true) };
            groupQuery.Criteria.AddCondition(SchemaNames.Qualify(SchemaNames.ActionConditionGroup.RuleAction), ConditionOperator.In,
                actions.Select(a => (object)a.Id).ToArray());
            var groupRows = _service.RetrieveMultiple(groupQuery).Entities.ToList();
            if (groupRows.Count == 0) return;

            var testQuery = new QueryExpression(SchemaNames.Qualify(SchemaNames.ActionConditionTest.Entity)) { ColumnSet = new ColumnSet(true) };
            testQuery.Criteria.AddCondition(SchemaNames.Qualify(SchemaNames.ActionConditionTest.Group), ConditionOperator.In,
                groupRows.Select(g => (object)g.Id).ToArray());
            var testRows = _service.RetrieveMultiple(testQuery).Entities;

            var groups = groupRows.ToDictionary(g => g.Id, g => new ActionConditionGroup
            {
                Id = g.Id,
                LogicalOperator = (Ascentix.RulesEngine.Core.Models.LogicalOperator)(g.GetAttributeValue<OptionSetValue>(SchemaNames.Qualify(SchemaNames.ActionConditionGroup.LogicalOperator))?.Value ?? (int)Ascentix.RulesEngine.Core.Models.LogicalOperator.And),
                Order = g.GetAttributeValue<int>(SchemaNames.Qualify(SchemaNames.ActionConditionGroup.Order)),
            });
            foreach (var t in testRows.OrderBy(t => t.GetAttributeValue<int>(SchemaNames.Qualify(SchemaNames.ActionConditionTest.Order))))
            {
                var groupId = t.GetAttributeValue<EntityReference>(SchemaNames.Qualify(SchemaNames.ActionConditionTest.Group))?.Id;
                if (groupId.HasValue && groups.TryGetValue(groupId.Value, out var owner))
                    owner.Tests.Add(new ActionConditionTest
                    {
                        Id = t.Id,
                        OutcomeId = t.GetAttributeValue<EntityReference>(SchemaNames.Qualify(SchemaNames.ActionConditionTest.Outcome))?.Id,
                        Expected = t.GetAttributeValue<bool>(SchemaNames.Qualify(SchemaNames.ActionConditionTest.Expected)),
                        Order = t.GetAttributeValue<int>(SchemaNames.Qualify(SchemaNames.ActionConditionTest.Order)),
                    });
            }

            var byAction = actions.ToDictionary(a => a.Id);
            foreach (var g in groupRows.OrderBy(g => g.GetAttributeValue<int>(SchemaNames.Qualify(SchemaNames.ActionConditionGroup.Order))))
            {
                var node = groups[g.Id];
                var parent = g.GetAttributeValue<EntityReference>(SchemaNames.Qualify(SchemaNames.ActionConditionGroup.ParentGroup))?.Id;
                if (parent.HasValue)
                {
                    if (groups.TryGetValue(parent.Value, out var p)) p.Groups.Add(node);
                    continue;
                }
                var actionId = g.GetAttributeValue<EntityReference>(SchemaNames.Qualify(SchemaNames.ActionConditionGroup.RuleAction)).Id;
                if (!byAction.TryGetValue(actionId, out var action)) continue;
                if (action.Condition != null)
                    throw new InvalidPluginExecutionException(
                        $"Action {actionId} has more than one \"Fires when\" root group; an action may have only one.");
                action.Condition = node;
            }
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
