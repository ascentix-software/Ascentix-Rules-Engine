using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Loaders
{
    /// <summary>
    /// Maps raw Entity objects from the RuleLoader into typed
    /// ConditionGroup trees with all children, conditions,
    /// search criteria groups, and node filter groups wired.
    /// </summary>
    public class ConditionGroupMapper
    {
        private static readonly string RuleToConditionGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.RuleConditionGroup);
        private static readonly string ConditionGroupChildGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.ConditionGroupConditionGroup);
        private static readonly string ConditionGroupToConditionsRel = SchemaNames.Qualify(SchemaNames.Relationships.ConditionGroupCondition);
        private static readonly string ConditionGroupToFilterGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.ConditionGroupNodeFilterGroup);
        private static readonly string ConditionToCriteriaGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.ConditionCriteriaGroup);
        private static readonly string CriteriaGroupChildGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.CriteriaGroupCriteriaGroup);
        private static readonly string CriteriaGroupToCriteriaRel = SchemaNames.Qualify(SchemaNames.Relationships.CriteriaGroupCriterion);
        private static readonly string FilterGroupChildGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.NodeFilterGroupNodeFilterGroup);
        private static readonly string FilterGroupToCriteriaRel = SchemaNames.Qualify(SchemaNames.Relationships.NodeFilterGroupCriterion);

        private static readonly string ConditionGroupParentField = SchemaNames.Qualify(SchemaNames.ConditionGroup.ParentConditionGroup);
        private static readonly string ConditionGroupLogicalOpField = SchemaNames.Qualify(SchemaNames.ConditionGroup.LogicalOperator);
        private static readonly string ConditionGroupIsExecutionField = SchemaNames.Qualify(SchemaNames.ConditionGroup.IsExecutionCondition);

        private static readonly string ConditionTableConfigField = SchemaNames.Qualify(SchemaNames.RuleCondition.TableConfig);
        private static readonly string ConditionTypeField = SchemaNames.Qualify(SchemaNames.RuleCondition.ConditionType);
        private static readonly string ConditionComparisonColumnField = SchemaNames.Qualify(SchemaNames.RuleCondition.ComparisonColumn);
        private static readonly string ConditionComparisonOpField = SchemaNames.Qualify(SchemaNames.RuleCondition.ComparisonOperator);
        private static readonly string ConditionComparisonValueField = SchemaNames.Qualify(SchemaNames.RuleCondition.ComparisonValue);
        private static readonly string ConditionMinRowsField = SchemaNames.Qualify(SchemaNames.RuleCondition.MinExpectedRows);
        private static readonly string ConditionMaxRowsField = SchemaNames.Qualify(SchemaNames.RuleCondition.MaxExpectedRows);
        private static readonly string ConditionValueSourceField = SchemaNames.Qualify(SchemaNames.RuleCondition.ComparisonValueSource);
        private static readonly string ConditionValueNodeField = SchemaNames.Qualify(SchemaNames.RuleCondition.ComparisonValueNode);
        private static readonly string ConditionValueColumnField = SchemaNames.Qualify(SchemaNames.RuleCondition.ComparisonValueColumn);
        private static readonly string ConditionExpressionField = SchemaNames.Qualify(SchemaNames.RuleCondition.ConditionExpression);

        private static readonly string CriterionFieldNameField = SchemaNames.Qualify(SchemaNames.SearchCriterion.FieldName);
        private static readonly string CriterionOperatorField = SchemaNames.Qualify(SchemaNames.SearchCriterion.Operator);
        private static readonly string CriterionValueField = SchemaNames.Qualify(SchemaNames.SearchCriterion.Value);

        private static readonly string FilterCriterionFieldNameField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.FieldName);
        private static readonly string FilterCriterionOperatorField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.Operator);
        private static readonly string FilterCriterionValueField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.Value);
        private static readonly string FilterCriterionValueSourceField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.ComparisonValueSource);
        private static readonly string FilterCriterionValueNodeField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.ComparisonValueNode);
        private static readonly string FilterCriterionValueColumnField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.ComparisonValueColumn);
        private static readonly string FilterCriterionTypeField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.CriterionType);
        private static readonly string FilterCriterionCollectionNodeField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.CollectionNode);
        private static readonly string FilterCriterionMinCountField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.MinCount);
        private static readonly string FilterCriterionMaxCountField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.MaxCount);
        private static readonly string FilterGroupOwningCriterionRel = SchemaNames.Qualify(SchemaNames.Relationships.NodeFilterGroupOwningCriterion);

        private static readonly string CriteriaGroupParentField = SchemaNames.Qualify(SchemaNames.SearchCriteriaGroup.ParentCriteriaGroup);
        private static readonly string CriteriaGroupLogicalOpField = SchemaNames.Qualify(SchemaNames.SearchCriteriaGroup.LogicalOperator);

        private static readonly string FilterGroupTableConfigField = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.TableConfigNode);
        private static readonly string FilterGroupParentField = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.ParentFilterGroup);
        private static readonly string FilterGroupLogicalOpField = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.LogicalOperator);

        public List<ConditionGroup> MapConditionGroups(List<Entity> rules)
        {
            var rootGroups = new List<ConditionGroup>();

            foreach (var rule in rules)
            {
                if (!rule.RelatedEntities.TryGetValue(
                    new Relationship(RuleToConditionGroupsRel),
                    out var groupCollection))
                    continue;

                // Step 1: map all root groups flat (child groups wired via RelatedEntities)
                foreach (var groupEntity in groupCollection.Entities)
                {
                    var group = MapGroup(groupEntity, rule.Id);
                    WireChildGroupsRecursive(groupEntity, group);
                    rootGroups.Add(group);
                }
            }

            return rootGroups;
        }

        private void WireChildGroupsRecursive(Entity groupEntity, ConditionGroup group)
        {
            // Wire conditions
            if (groupEntity.RelatedEntities.TryGetValue(
                new Relationship(ConditionGroupToConditionsRel),
                out var conditionCollection))
            {
                group.Conditions = conditionCollection.Entities
                    .Select(e => MapCondition(e, group.Id))
                    .ToList();
            }

            // Wire node filter groups
            if (groupEntity.RelatedEntities.TryGetValue(
                new Relationship(ConditionGroupToFilterGroupsRel),
                out var filterGroupCollection))
            {
                group.NodeFilterGroups = filterGroupCollection.Entities
                    .Select(e => MapFilterGroup(e, group.Id))
                    .ToList();
            }

            // Wire child condition groups recursively
            if (!groupEntity.RelatedEntities.TryGetValue(
                new Relationship(ConditionGroupChildGroupsRel),
                out var childGroupCollection))
                return;

            foreach (var childEntity in childGroupCollection.Entities)
            {
                var childGroup = MapGroup(childEntity, group.RuleId);
                WireChildGroupsRecursive(childEntity, childGroup);
                group.ChildGroups.Add(childGroup);
            }
        }

        private ConditionGroup MapGroup(Entity e, Guid ruleId)
        {
            return new ConditionGroup
            {
                Id = e.Id,
                RuleId = ruleId,
                ParentConditionGroupId = e.GetAttributeValue<EntityReference>(ConditionGroupParentField)?.Id,
                LogicalOperator = (Ascentix.RulesEngine.Core.Models.LogicalOperator)e.GetAttributeValue<OptionSetValue>(ConditionGroupLogicalOpField).Value,
                IsExecutionCondition = e.GetAttributeValue<bool>(ConditionGroupIsExecutionField),
                ChildGroups = new List<ConditionGroup>(),
                Conditions = new List<RuleCondition>(),
                NodeFilterGroups = new List<NodeFilterGroup>()
            };
        }

        private RuleCondition MapCondition(Entity e, Guid groupId)
        {
            return new RuleCondition
            {
                Id = e.Id,
                ConditionGroupId = groupId,
                TableConfigNodeId = e.GetAttributeValue<EntityReference>(ConditionTableConfigField)?.Id ?? Guid.Empty,
                ConditionType = e.GetAttributeValue<OptionSetValue>(ConditionTypeField) != null
                                           ? (ConditionType)e.GetAttributeValue<OptionSetValue>(ConditionTypeField).Value
                                           : ConditionType.FieldComparison,
                ComparisonColumn = e.GetAttributeValue<string>(ConditionComparisonColumnField),
                ComparisonOperator = e.GetAttributeValue<OptionSetValue>(ConditionComparisonOpField) != null
                                           ? (ComparisonOperator?)((ComparisonOperator)e.GetAttributeValue<OptionSetValue>(ConditionComparisonOpField).Value)
                                           : null,
                ComparisonValue = e.GetAttributeValue<string>(ConditionComparisonValueField),
                ValueSource = e.GetAttributeValue<OptionSetValue>(ConditionValueSourceField) != null
                    ? (ComparisonValueSource)e.GetAttributeValue<OptionSetValue>(ConditionValueSourceField).Value
                    : ComparisonValueSource.Literal,
                ComparisonValueNodeId = e.GetAttributeValue<EntityReference>(ConditionValueNodeField)?.Id,
                ComparisonValueColumn = e.GetAttributeValue<string>(ConditionValueColumnField),
                Expression = e.GetAttributeValue<string>(ConditionExpressionField),
                MinExpectedRows = e.GetAttributeValue<int?>(ConditionMinRowsField),
                MaxExpectedRows = e.GetAttributeValue<int?>(ConditionMaxRowsField),
                SearchCriteriaGroups = MapSearchCriteriaGroups(e, e.Id)
            };
        }

        private List<SearchCriteriaGroup> MapSearchCriteriaGroups(
            Entity conditionEntity, Guid conditionId)
        {
            if (!conditionEntity.RelatedEntities.TryGetValue(
                new Relationship(ConditionToCriteriaGroupsRel),
                out var groupCollection))
                return new List<SearchCriteriaGroup>();

            return groupCollection.Entities
                .Select(e => MapSearchCriteriaGroup(e, conditionId))
                .ToList();
        }

        private SearchCriteriaGroup MapSearchCriteriaGroup(
            Entity e, Guid conditionId)
        {
            var group = new SearchCriteriaGroup
            {
                Id = e.Id,
                RuleConditionId = conditionId,
                ParentCriteriaGroupId = e.GetAttributeValue<EntityReference>(CriteriaGroupParentField)?.Id,
                LogicalOperator = (Ascentix.RulesEngine.Core.Models.LogicalOperator)e.GetAttributeValue<OptionSetValue>(CriteriaGroupLogicalOpField).Value,
                Criteria = MapCriteria(e, CriteriaGroupToCriteriaRel),
                ChildGroups = new List<SearchCriteriaGroup>()
            };

            // Wire child criteria groups recursively
            if (e.RelatedEntities.TryGetValue(
                new Relationship(CriteriaGroupChildGroupsRel),
                out var childCollection))
            {
                group.ChildGroups = childCollection.Entities
                    .Select(child => MapSearchCriteriaGroup(child, conditionId))
                    .ToList();
            }

            return group;
        }

        private NodeFilterGroup MapFilterGroup(Entity e, Guid conditionGroupId)
        {
            var group = new NodeFilterGroup
            {
                Id = e.Id,
                ConditionGroupId = conditionGroupId,
                TableConfigNodeId = e.Contains(FilterGroupTableConfigField) ? e.GetAttributeValue<EntityReference>(FilterGroupTableConfigField).Id : Guid.Empty,
                ParentFilterGroupId = e.GetAttributeValue<EntityReference>(FilterGroupParentField)?.Id,
                RuleConditionId = e.GetAttributeValue<EntityReference>(
                    SchemaNames.Qualify(SchemaNames.NodeFilterGroup.RuleCondition))?.Id,
                LogicalOperator = (Ascentix.RulesEngine.Core.Models.LogicalOperator)e.GetAttributeValue<OptionSetValue>(FilterGroupLogicalOpField).Value,
                Criteria = MapFilterCriteria(e, FilterGroupToCriteriaRel, conditionGroupId),
                ChildGroups = new List<NodeFilterGroup>()
            };

            // Wire child filter groups recursively
            if (e.RelatedEntities.TryGetValue(
                new Relationship(FilterGroupChildGroupsRel),
                out var childCollection))
            {
                group.ChildGroups = childCollection.Entities
                    .Select(child => MapFilterGroup(child, conditionGroupId))
                    .ToList();
            }

            return group;
        }

        private List<SearchCriterion> MapCriteria(Entity groupEntity, string relationshipName)
        {
            if (!groupEntity.RelatedEntities.TryGetValue(
                new Relationship(relationshipName),
                out var criteriaCollection))
                return new List<SearchCriterion>();

            return criteriaCollection.Entities.Select(e => new SearchCriterion
            {
                FieldName = e.GetAttributeValue<string>(CriterionFieldNameField),
                Operator = e.GetAttributeValue<string>(CriterionOperatorField),
                Value = e.GetAttributeValue<string>(CriterionValueField)
            }).ToList();
        }

        /// <summary>
        /// FieldName/Operator/Value plus value-source mapping (ValueSource/ComparisonValueNodeId/
        /// ComparisonValueColumn) for node-filter criteria. Literal is the default when
        /// ComparisonValueSource is unset, keeping back-compat with existing filter criteria.
        /// </summary>
        private List<NodeFilterCriterion> MapFilterCriteria(Entity groupEntity, string relationshipName, Guid conditionGroupId)
        {
            if (!groupEntity.RelatedEntities.TryGetValue(
                new Relationship(relationshipName),
                out var criteriaCollection))
                return new List<NodeFilterCriterion>();

            return criteriaCollection.Entities
                .Select(e => MapFilterCriterion(e, conditionGroupId))
                .ToList();
        }

        /// <summary>
        /// Maps a single node-filter criterion. A Comparison criterion (the default, and the
        /// only kind back-compat rows have) maps FieldName/Operator/Value + the value-source
        /// RHS. An Exists criterion additionally reads CollectionNodeId/MinCount/MaxCount and
        /// assembles SubFilter from the nodefiltergroup RuleLoader wired onto this criterion
        /// (the group whose asx_owningcriterion == this criterion's id).
        /// </summary>
        private NodeFilterCriterion MapFilterCriterion(Entity e, Guid conditionGroupId)
        {
            var kind = e.GetAttributeValue<OptionSetValue>(FilterCriterionTypeField) is OptionSetValue kindOsv
                ? (CriterionKind)kindOsv.Value : CriterionKind.Comparison;

            var criterion = new NodeFilterCriterion
            {
                Kind = kind,
                FieldName = e.GetAttributeValue<string>(FilterCriterionFieldNameField),
                Operator = e.GetAttributeValue<string>(FilterCriterionOperatorField),
                Value = e.GetAttributeValue<string>(FilterCriterionValueField),
                ValueSource = e.GetAttributeValue<OptionSetValue>(FilterCriterionValueSourceField) is OptionSetValue vs
                    ? (ComparisonValueSource)vs.Value : ComparisonValueSource.Literal,
                ComparisonValueNodeId = e.GetAttributeValue<EntityReference>(FilterCriterionValueNodeField)?.Id,
                ComparisonValueColumn = e.GetAttributeValue<string>(FilterCriterionValueColumnField),
            };

            if (kind != CriterionKind.Exists)
                return criterion;

            criterion.CollectionNodeId = e.GetAttributeValue<EntityReference>(FilterCriterionCollectionNodeField)?.Id;
            criterion.MinCount = e.GetAttributeValue<int?>(FilterCriterionMinCountField);
            criterion.MaxCount = e.GetAttributeValue<int?>(FilterCriterionMaxCountField);

            if (e.RelatedEntities.TryGetValue(new Relationship(FilterGroupOwningCriterionRel), out var subGroupCollection)
                && subGroupCollection.Entities.Count > 0)
            {
                criterion.SubFilter = MapFilterGroup(subGroupCollection.Entities[0], conditionGroupId);
            }

            return criterion;
        }
    }
}
