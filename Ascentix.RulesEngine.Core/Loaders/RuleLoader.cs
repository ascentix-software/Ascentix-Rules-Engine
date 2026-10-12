using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Loaders
{
    /// <summary>
    /// Loads active Rules for a triggering entity via batch QueryExpressions.
    /// Wires the full RelatedEntities hierarchy after retrieval.
    /// </summary>
    public class RuleLoader
    {
        private readonly IOrganizationService _service;

        private static readonly string RuleEntity = SchemaNames.Qualify(SchemaNames.Rule.Entity);
        private static readonly string RuleTriggeringEntityField = SchemaNames.Qualify(SchemaNames.Rule.TableLogicalName);
        // RuleIsActiveField retired in 2H. The loader now filters by statuscode == Published
        private static readonly string RuleTriggersField = SchemaNames.Qualify(SchemaNames.Rule.Triggers);

        private static readonly string ConditionGroupEntity = SchemaNames.Qualify(SchemaNames.ConditionGroup.Entity);
        private static readonly string ConditionGroupRuleLookup = SchemaNames.Qualify(SchemaNames.ConditionGroup.Rule);
        private static readonly string ConditionGroupParentLookup = SchemaNames.Qualify(SchemaNames.ConditionGroup.ParentConditionGroup);
        private static readonly string ConditionGroupLogicalOperatorField = SchemaNames.Qualify(SchemaNames.ConditionGroup.LogicalOperator);
        private static readonly string ConditionGroupIsExecutionField = SchemaNames.Qualify(SchemaNames.ConditionGroup.IsExecutionCondition);
        private static readonly string ConditionGroupToConditionsRel = SchemaNames.Qualify(SchemaNames.Relationships.ConditionGroupCondition);
        private static readonly string ConditionGroupToFilterGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.ConditionGroupNodeFilterGroup);
        private static readonly string ConditionGroupChildGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.ConditionGroupConditionGroup);

        private static readonly string ConditionEntity = SchemaNames.Qualify(SchemaNames.RuleCondition.Entity);
        private static readonly string ConditionGroupLookup = SchemaNames.Qualify(SchemaNames.RuleCondition.ConditionGroup);
        private static readonly string ConditionTableConfigLookup = SchemaNames.Qualify(SchemaNames.RuleCondition.TableConfig);
        private static readonly string ConditionTypeField = SchemaNames.Qualify(SchemaNames.RuleCondition.ConditionType);
        private static readonly string ConditionComparisonColumnField = SchemaNames.Qualify(SchemaNames.RuleCondition.ComparisonColumn);
        private static readonly string ConditionComparisonOperatorField = SchemaNames.Qualify(SchemaNames.RuleCondition.ComparisonOperator);
        private static readonly string ConditionComparisonValueField = SchemaNames.Qualify(SchemaNames.RuleCondition.ComparisonValue);
        private static readonly string ConditionMinRowsField = SchemaNames.Qualify(SchemaNames.RuleCondition.MinExpectedRows);
        private static readonly string ConditionMaxRowsField = SchemaNames.Qualify(SchemaNames.RuleCondition.MaxExpectedRows);
        private static readonly string ConditionToCriteriaGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.ConditionCriteriaGroup);

        private static readonly string CriteriaGroupEntity = SchemaNames.Qualify(SchemaNames.SearchCriteriaGroup.Entity);
        private static readonly string CriteriaGroupConditionLookup = SchemaNames.Qualify(SchemaNames.SearchCriteriaGroup.RuleCondition);
        private static readonly string CriteriaGroupParentLookup = SchemaNames.Qualify(SchemaNames.SearchCriteriaGroup.ParentCriteriaGroup);
        private static readonly string CriteriaGroupLogicalOperatorField = SchemaNames.Qualify(SchemaNames.SearchCriteriaGroup.LogicalOperator);
        private static readonly string CriteriaGroupToCriteriaRel = SchemaNames.Qualify(SchemaNames.Relationships.CriteriaGroupCriterion);
        private static readonly string CriteriaGroupChildGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.CriteriaGroupCriteriaGroup);

        private static readonly string CriterionEntity = SchemaNames.Qualify(SchemaNames.SearchCriterion.Entity);
        private static readonly string CriterionGroupLookup = SchemaNames.Qualify(SchemaNames.SearchCriterion.CriteriaGroup);
        private static readonly string CriterionFieldNameField = SchemaNames.Qualify(SchemaNames.SearchCriterion.FieldName);
        private static readonly string CriterionOperatorField = SchemaNames.Qualify(SchemaNames.SearchCriterion.Operator);
        private static readonly string CriterionValueField = SchemaNames.Qualify(SchemaNames.SearchCriterion.Value);

        // Condition filters: node-filter groups scoped to a condition group (Q6). Their criteria,
        // child groups and EXISTS sub-filters are loaded and wired by NodeFilterGraphLoader.
        private static readonly string FilterGroupConditionGroupLookup = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.ConditionGroup);

        public RuleLoader(IOrganizationService service)
        {
            _service = service;
        }

        public List<Entity> LoadRules(string triggeringEntityLogicalName)
        {
            // Q1: Load active rules for this entity
            var ruleQuery = new QueryExpression(RuleEntity)
            {
                ColumnSet = new ColumnSet(true)
            };
            ruleQuery.Criteria.AddCondition(RuleTriggeringEntityField,
                ConditionOperator.Equal, triggeringEntityLogicalName);
            ruleQuery.Criteria.AddCondition("statuscode",
                ConditionOperator.Equal, (int)RuleStatus.Published);

            var rules = _service.RetrieveMultiple(ruleQuery).Entities.ToList();
            return WireRuleGraph(rules);
        }

        /// <summary>
        /// Loads a single rule by primary id with its full RelatedEntities graph, regardless of
        /// statuscode (Draft/Published/Archived). For validation, which must inspect unpublished rules.
        /// </summary>
        public List<Entity> LoadRuleById(Guid ruleId)
        {
            var idField = SchemaNames.PrimaryId(SchemaNames.DefaultPrefix, SchemaNames.Rule.Entity);
            var ruleQuery = new QueryExpression(RuleEntity) { ColumnSet = new ColumnSet(true) };
            ruleQuery.Criteria.AddCondition(idField, ConditionOperator.Equal, ruleId);

            var rules = _service.RetrieveMultiple(ruleQuery).Entities.ToList();
            return WireRuleGraph(rules);
        }

        // Loads + wires the full RelatedEntities graph for an already-fetched rule set.
        // Shared by LoadRules (table + Published) and LoadRuleById (single rule, any status).
        private List<Entity> WireRuleGraph(List<Entity> rules)
        {
            if (!rules.Any()) return rules;

            var ruleIds = rules.Select(r => (object)r.Id).ToArray();

            // Q2: Load all condition groups for these rules
            var conditionGroupQuery = new QueryExpression(ConditionGroupEntity)
            {
                ColumnSet = new ColumnSet(true)
            };
            conditionGroupQuery.Criteria.AddCondition(ConditionGroupRuleLookup,
                ConditionOperator.In, ruleIds);

            var conditionGroups = _service.RetrieveMultiple(conditionGroupQuery).Entities.ToList();
            if (!conditionGroups.Any())
            {
                WireConditionGroupsToRules(rules, new List<Entity>());
                return rules;
            }

            var conditionGroupIds = conditionGroups.Select(g => (object)g.Id).ToArray();

            // Q3: Load all conditions for these groups
            var conditionQuery = new QueryExpression(ConditionEntity)
            {
                ColumnSet = new ColumnSet(true)
            };
            conditionQuery.Criteria.AddCondition(ConditionGroupLookup,
                ConditionOperator.In, conditionGroupIds);

            var conditions = _service.RetrieveMultiple(conditionQuery).Entities.ToList();
            var conditionIds = conditions.Select(c => (object)c.Id).ToArray();

            // Q4–Q5: Load search criteria groups and criteria
            if (conditions.Any())
            {
                var criteriaGroupQuery = new QueryExpression(CriteriaGroupEntity)
                {
                    ColumnSet = new ColumnSet(true)
                };
                criteriaGroupQuery.Criteria.AddCondition(CriteriaGroupConditionLookup,
                    ConditionOperator.In, conditionIds);

                var criteriaGroups = _service.RetrieveMultiple(criteriaGroupQuery).Entities.ToList();

                if (criteriaGroups.Any())
                {
                    var criteriaGroupIds = criteriaGroups.Select(g => (object)g.Id).ToArray();

                    var criterionQuery = new QueryExpression(CriterionEntity)
                    {
                        ColumnSet = new ColumnSet(true)
                    };
                    criterionQuery.Criteria.AddCondition(CriterionGroupLookup,
                        ConditionOperator.In, criteriaGroupIds);

                    var criteria = _service.RetrieveMultiple(criterionQuery).Entities.ToList();

                    WireCriteriaToGroups(criteriaGroups, criteria);
                    WireCriteriaGroupsToConditions(conditions, criteriaGroups);
                }
            }

            // Q6–Q9: Load node filter groups; NodeFilterGraphLoader loads their criteria and the
            // EXISTS criteria's sub-filter groups (owned by the criterion via asx_owningcriterion,
            // NOT scoped to a condition group, so Q6 does not retrieve them).
            var filterGroupQuery = new QueryExpression(NodeFilterGraphLoader.FilterGroupEntity)
            {
                ColumnSet = new ColumnSet(true)
            };
            filterGroupQuery.Criteria.AddCondition(FilterGroupConditionGroupLookup,
                ConditionOperator.In, conditionGroupIds);

            var filterGroups = _service.RetrieveMultiple(filterGroupQuery).Entities.ToList();

            if (filterGroups.Any())
            {
                NodeFilterGraphLoader.Wire(_service, filterGroups);
                WireFilterGroupsToConditionGroups(conditionGroups, filterGroups);
            }

            // Wire conditions and child groups to their condition groups
            WireConditionsToConditionGroups(conditionGroups, conditions);
            WireChildConditionGroupsToParents(conditionGroups);
            WireConditionGroupsToRules(rules, conditionGroups);

            return rules;
        }

        /// <summary>
        /// Loads active rules for the entity, then keeps only those whose
        /// asx_triggers multi-select includes the given trigger.
        /// </summary>
        public List<Entity> LoadRules(string triggeringEntityLogicalName, RuleTrigger trigger)
        {
            return LoadRules(triggeringEntityLogicalName)
                .Where(r => HasTrigger(r, trigger))
                .ToList();
        }

        /// <summary>
        /// Active rules for the entity tagged for the trigger AND applicable on
        /// the current origin channel (asx_channels empty ⇒ all channels).
        /// </summary>
        public List<Entity> LoadRules(string triggeringEntityLogicalName, RuleTrigger trigger, RuleChannel channel)
        {
            return LoadRules(triggeringEntityLogicalName, trigger)
                .Where(r => ChannelFilter.Applies(r, channel))
                .ToList();
        }

        private static bool HasTrigger(Entity rule, RuleTrigger trigger)
        {
            var triggers = rule.GetAttributeValue<OptionSetValueCollection>(RuleTriggersField);
            return triggers != null && triggers.Any(o => o.Value == (int)trigger);
        }

        // ── Wiring Helpers ────────────────────────────────────────────────────

        private void WireCriteriaToGroups(List<Entity> criteriaGroups, List<Entity> criteria)
        {
            var byGroup = criteria
                .GroupBy(c => c.GetAttributeValue<EntityReference>(CriterionGroupLookup).Id)
                .ToDictionary(g => g.Key, g => g.ToList());

            foreach (var group in criteriaGroups)
            {
                group.RelatedEntities[new Relationship(CriteriaGroupToCriteriaRel)] =
                    new EntityCollection(
                        byGroup.TryGetValue(group.Id, out var crit) ? crit : new List<Entity>());
            }
        }

        private void WireCriteriaGroupsToConditions(List<Entity> conditions, List<Entity> criteriaGroups)
        {
            var rootGroups = criteriaGroups
                .Where(g => g.GetAttributeValue<EntityReference>(CriteriaGroupParentLookup) == null)
                .GroupBy(g => g.GetAttributeValue<EntityReference>(CriteriaGroupConditionLookup).Id)
                .ToDictionary(g => g.Key, g => g.ToList());

            // Wire child groups to parents first
            var groupsById = criteriaGroups.ToDictionary(g => g.Id);
            foreach (var group in criteriaGroups)
            {
                var parentId = group.GetAttributeValue<EntityReference>(CriteriaGroupParentLookup)?.Id;
                if (parentId.HasValue && groupsById.TryGetValue(parentId.Value, out var parent))
                {
                    if (!parent.RelatedEntities.ContainsKey(new Relationship(CriteriaGroupChildGroupsRel)))
                        parent.RelatedEntities[new Relationship(CriteriaGroupChildGroupsRel)] = new EntityCollection();
                    parent.RelatedEntities[new Relationship(CriteriaGroupChildGroupsRel)].Entities.Add(group);
                }
            }

            foreach (var condition in conditions)
            {
                condition.RelatedEntities[new Relationship(ConditionToCriteriaGroupsRel)] =
                    new EntityCollection(
                        rootGroups.TryGetValue(condition.Id, out var groups) ? groups : new List<Entity>());
            }
        }

        private void WireConditionsToConditionGroups(List<Entity> conditionGroups, List<Entity> conditions)
        {
            var byGroup = conditions
                .GroupBy(c => c.GetAttributeValue<EntityReference>(ConditionGroupLookup).Id)
                .ToDictionary(g => g.Key, g => g.ToList());

            foreach (var group in conditionGroups)
            {
                group.RelatedEntities[new Relationship(ConditionGroupToConditionsRel)] =
                    new EntityCollection(
                        byGroup.TryGetValue(group.Id, out var conds) ? conds : new List<Entity>());
            }
        }

        private void WireChildConditionGroupsToParents(List<Entity> conditionGroups)
        {
            var groupsById = conditionGroups.ToDictionary(g => g.Id);
            foreach (var group in conditionGroups)
            {
                var parentId = group.GetAttributeValue<EntityReference>(ConditionGroupParentLookup)?.Id;
                if (parentId.HasValue && groupsById.TryGetValue(parentId.Value, out var parent))
                {
                    if (!parent.RelatedEntities.ContainsKey(new Relationship(ConditionGroupChildGroupsRel)))
                        parent.RelatedEntities[new Relationship(ConditionGroupChildGroupsRel)] = new EntityCollection();
                    parent.RelatedEntities[new Relationship(ConditionGroupChildGroupsRel)].Entities.Add(group);
                }
            }
        }

        private void WireConditionGroupsToRules(List<Entity> rules, List<Entity> conditionGroups)
        {
            var rootGroupsByRule = conditionGroups
                .Where(g => g.GetAttributeValue<EntityReference>(ConditionGroupParentLookup) == null)
                .GroupBy(g => g.GetAttributeValue<EntityReference>(ConditionGroupRuleLookup).Id)
                .ToDictionary(g => g.Key, g => g.ToList());

            foreach (var rule in rules)
            {
                rule.RelatedEntities[new Relationship(SchemaNames.Qualify(SchemaNames.Relationships.RuleConditionGroup))] =
                    new EntityCollection(
                        rootGroupsByRule.TryGetValue(rule.Id, out var groups) ? groups : new List<Entity>());
            }
        }

        private void WireFilterGroupsToConditionGroups(List<Entity> conditionGroups, List<Entity> filterGroups)
        {
            var rootFilterGroupsByConditionGroup = filterGroups
                .Where(g => g.GetAttributeValue<EntityReference>(NodeFilterGraphLoader.FilterGroupParentLookup) == null)
                .GroupBy(g => g.GetAttributeValue<EntityReference>(FilterGroupConditionGroupLookup).Id)
                .ToDictionary(g => g.Key, g => g.ToList());

            foreach (var conditionGroup in conditionGroups)
            {
                conditionGroup.RelatedEntities[new Relationship(ConditionGroupToFilterGroupsRel)] =
                    new EntityCollection(
                        rootFilterGroupsByConditionGroup.TryGetValue(
                            conditionGroup.Id, out var groups) ? groups : new List<Entity>());
            }
        }
    }
}
