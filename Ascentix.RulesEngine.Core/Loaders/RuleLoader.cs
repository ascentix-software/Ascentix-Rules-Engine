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

        private static readonly string FilterGroupEntity = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.Entity);
        private static readonly string FilterGroupConditionGroupLookup = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.ConditionGroup);
        private static readonly string FilterGroupTableConfigLookup = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.TableConfigNode);
        private static readonly string FilterGroupParentLookup = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.ParentFilterGroup);
        private static readonly string FilterGroupLogicalOperatorField = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.LogicalOperator);
        private static readonly string FilterGroupToCriteriaRel = SchemaNames.Qualify(SchemaNames.Relationships.NodeFilterGroupCriterion);
        private static readonly string FilterGroupChildGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.NodeFilterGroupNodeFilterGroup);

        private static readonly string FilterCriterionEntity = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.Entity);
        private static readonly string FilterCriterionGroupLookup = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.FilterGroup);
        private static readonly string FilterCriterionFieldNameField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.FieldName);
        private static readonly string FilterCriterionOperatorField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.Operator);
        private static readonly string FilterCriterionValueField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.Value);
        private static readonly string FilterCriterionTypeField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.CriterionType);

        // EXISTS sub-filter: a nodefiltergroup owned by a criterion (asx_owningcriterion),
        // not scoped to a condition group, retrieved separately (Q8/Q9 below).
        private static readonly string FilterGroupOwningCriterionLookup = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.OwningCriterion);
        private static readonly string FilterGroupOwningCriterionRel = SchemaNames.Qualify(SchemaNames.Relationships.NodeFilterGroupOwningCriterion);

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

            // Q6–Q7: Load node filter groups and filter criteria
            var filterGroupQuery = new QueryExpression(FilterGroupEntity)
            {
                ColumnSet = new ColumnSet(true)
            };
            filterGroupQuery.Criteria.AddCondition(FilterGroupConditionGroupLookup,
                ConditionOperator.In, conditionGroupIds);

            var filterGroups = _service.RetrieveMultiple(filterGroupQuery).Entities.ToList();

            if (filterGroups.Any())
            {
                var filterGroupIds = filterGroups.Select(g => (object)g.Id).ToArray();

                var filterCriterionQuery = new QueryExpression(FilterCriterionEntity)
                {
                    ColumnSet = new ColumnSet(true)
                };
                filterCriterionQuery.Criteria.AddCondition(FilterCriterionGroupLookup,
                    ConditionOperator.In, filterGroupIds);

                var filterCriteria = _service.RetrieveMultiple(filterCriterionQuery).Entities.ToList();

                WireFilterCriteriaToFilterGroups(filterGroups, filterCriteria);
                WireChildFilterGroupsToParents(filterGroups);
                WireFilterGroupsToConditionGroups(conditionGroups, filterGroups);

                // Q8–Q9: EXISTS criteria's sub-filter groups are owned by the criterion
                // (asx_owningcriterion), NOT scoped to a condition group, so the Q6 query
                // above does not retrieve them. Fetch separately and wire onto the criterion.
                LoadExistsSubFilters(filterCriteria);
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

        /// <summary>
        /// For every EXISTS filter criterion, loads its sub-filter group tree: the
        /// asx_nodefiltergroup owned by the criterion (asx_owningcriterion), plus any
        /// nested child groups (an EXISTS sub-filter may itself be an AND/OR tree of
        /// scalar criteria), plus all of those groups' criteria. It then wires the root
        /// sub-filter group onto its owning criterion so the mapper can find it.
        /// </summary>
        private void LoadExistsSubFilters(List<Entity> filterCriteria)
        {
            var existsCriteria = filterCriteria
                .Where(c => c.GetAttributeValue<OptionSetValue>(FilterCriterionTypeField)?.Value == (int)CriterionKind.Exists)
                .ToList();
            if (!existsCriteria.Any()) return;

            var existsCriterionIds = existsCriteria.Select(c => (object)c.Id).ToArray();

            var subFilterGroupQuery = new QueryExpression(FilterGroupEntity)
            {
                ColumnSet = new ColumnSet(true)
            };
            subFilterGroupQuery.Criteria.AddCondition(FilterGroupOwningCriterionLookup,
                ConditionOperator.In, existsCriterionIds);

            var rootSubFilterGroups = _service.RetrieveMultiple(subFilterGroupQuery).Entities.ToList();
            if (!rootSubFilterGroups.Any()) return;

            // Breadth-first descend the sub-filter's own AND/OR tree via ParentFilterGroup:
            // it is not scoped to a condition group, so it cannot be picked up by Q6.
            var subFilterGroups = new List<Entity>(rootSubFilterGroups);
            var seen = new HashSet<Guid>(rootSubFilterGroups.Select(g => g.Id));
            var frontier = rootSubFilterGroups;
            while (frontier.Any())
            {
                var frontierIds = frontier.Select(g => (object)g.Id).ToArray();
                var childQuery = new QueryExpression(FilterGroupEntity)
                {
                    ColumnSet = new ColumnSet(true)
                };
                childQuery.Criteria.AddCondition(FilterGroupParentLookup, ConditionOperator.In, frontierIds);
                var children = _service.RetrieveMultiple(childQuery).Entities.ToList();
                foreach (var child in children)
                    if (!seen.Add(child.Id))
                        throw new InvalidPluginExecutionException(
                            $"Node-filter group {child.Id} has a cyclic parent chain " +
                            "(asx_parentfiltergroup); the rule cannot be loaded.");
                frontier = children;
                subFilterGroups.AddRange(children);
            }

            var subFilterGroupIds = subFilterGroups.Select(g => (object)g.Id).ToArray();
            var subCriterionQuery = new QueryExpression(FilterCriterionEntity)
            {
                ColumnSet = new ColumnSet(true)
            };
            subCriterionQuery.Criteria.AddCondition(FilterCriterionGroupLookup,
                ConditionOperator.In, subFilterGroupIds);

            var subCriteria = _service.RetrieveMultiple(subCriterionQuery).Entities.ToList();

            WireFilterCriteriaToFilterGroups(subFilterGroups, subCriteria);
            WireChildFilterGroupsToParents(subFilterGroups);
            WireSubFilterGroupsToOwningCriteria(existsCriteria, rootSubFilterGroups);
        }

        private void WireSubFilterGroupsToOwningCriteria(List<Entity> existsCriteria, List<Entity> rootSubFilterGroups)
        {
            var byOwner = new Dictionary<Guid, Entity>();
            foreach (var group in rootSubFilterGroups)
            {
                var ownerId = group.GetAttributeValue<EntityReference>(FilterGroupOwningCriterionLookup)?.Id;
                if (!ownerId.HasValue) continue;

                if (byOwner.ContainsKey(ownerId.Value))
                {
                    throw new InvalidPluginExecutionException(
                        $"Exists criterion {ownerId.Value} is the owning criterion for more than one " +
                        "sub-filter group. An EXISTS criterion may own only one sub-filter group.");
                }

                byOwner[ownerId.Value] = group;
            }

            foreach (var criterion in existsCriteria)
            {
                if (byOwner.TryGetValue(criterion.Id, out var subGroup))
                {
                    criterion.RelatedEntities[new Relationship(FilterGroupOwningCriterionRel)] =
                        new EntityCollection(new List<Entity> { subGroup });
                }
            }
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

        private void WireFilterCriteriaToFilterGroups(List<Entity> filterGroups, List<Entity> filterCriteria)
        {
            var byGroup = filterCriteria
                .GroupBy(c => c.GetAttributeValue<EntityReference>(FilterCriterionGroupLookup).Id)
                .ToDictionary(g => g.Key, g => g.ToList());

            foreach (var group in filterGroups)
            {
                group.RelatedEntities[new Relationship(FilterGroupToCriteriaRel)] =
                    new EntityCollection(
                        byGroup.TryGetValue(group.Id, out var crit) ? crit : new List<Entity>());
            }
        }

        private void WireChildFilterGroupsToParents(List<Entity> filterGroups)
        {
            var groupsById = filterGroups.ToDictionary(g => g.Id);
            foreach (var group in filterGroups)
            {
                var parentId = group.GetAttributeValue<EntityReference>(FilterGroupParentLookup)?.Id;
                if (parentId.HasValue && groupsById.TryGetValue(parentId.Value, out var parent))
                {
                    if (!parent.RelatedEntities.ContainsKey(new Relationship(FilterGroupChildGroupsRel)))
                        parent.RelatedEntities[new Relationship(FilterGroupChildGroupsRel)] = new EntityCollection();
                    parent.RelatedEntities[new Relationship(FilterGroupChildGroupsRel)].Entities.Add(group);
                }
            }
        }

        private void WireFilterGroupsToConditionGroups(List<Entity> conditionGroups, List<Entity> filterGroups)
        {
            var rootFilterGroupsByConditionGroup = filterGroups
                .Where(g => g.GetAttributeValue<EntityReference>(FilterGroupParentLookup) == null)
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
