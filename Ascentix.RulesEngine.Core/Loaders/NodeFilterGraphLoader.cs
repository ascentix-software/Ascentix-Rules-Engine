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
    /// Loads and wires the node-filter graph under a set of asx_nodefiltergroup rows: their
    /// criteria, their nested child groups and every EXISTS criterion's sub-filter tree, as
    /// RelatedEntities for <see cref="ConditionGroupMapper"/>. Shared by condition filters
    /// (<see cref="RuleLoader"/>) and actions' Rows filters (<see cref="RuleActionLoader"/>).
    /// </summary>
    internal static class NodeFilterGraphLoader
    {
        internal static readonly string FilterGroupEntity = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.Entity);
        internal static readonly string FilterGroupParentLookup = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.ParentFilterGroup);

        private static readonly string FilterGroupToCriteriaRel = SchemaNames.Qualify(SchemaNames.Relationships.NodeFilterGroupCriterion);
        private static readonly string FilterGroupChildGroupsRel = SchemaNames.Qualify(SchemaNames.Relationships.NodeFilterGroupNodeFilterGroup);

        private static readonly string FilterCriterionEntity = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.Entity);
        private static readonly string FilterCriterionGroupLookup = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.FilterGroup);
        private static readonly string FilterCriterionTypeField = SchemaNames.Qualify(SchemaNames.NodeFilterCriterion.CriterionType);

        // EXISTS sub-filter: a nodefiltergroup owned by a criterion (asx_owningcriterion), not
        // scoped to a condition group or an action, so retrieved separately.
        private static readonly string FilterGroupOwningCriterionLookup = SchemaNames.Qualify(SchemaNames.NodeFilterGroup.OwningCriterion);
        private static readonly string FilterGroupOwningCriterionRel = SchemaNames.Qualify(SchemaNames.Relationships.NodeFilterGroupOwningCriterion);

        /// <summary>Loads the criteria of the given asx_nodefiltergroup rows, wires criteria and
        /// child groups onto them (RelatedEntities), then loads and wires every EXISTS criterion's
        /// sub-filter tree, which its criterion owns and so lies outside these rows. Wires in place.</summary>
        public static void Wire(IOrganizationService service, List<Entity> filterGroups)
        {
            if (filterGroups == null || filterGroups.Count == 0) return;
            var ids = filterGroups.Select(g => (object)g.Id).ToArray();
            var criterionQuery = new QueryExpression(FilterCriterionEntity) { ColumnSet = new ColumnSet(true) };
            criterionQuery.Criteria.AddCondition(FilterCriterionGroupLookup, ConditionOperator.In, ids);
            var criteria = service.RetrieveMultiple(criterionQuery).Entities.ToList();

            WireFilterCriteriaToFilterGroups(filterGroups, criteria);
            WireChildFilterGroupsToParents(filterGroups);
            LoadExistsSubFilters(service, criteria);
        }

        /// <summary>
        /// For every EXISTS filter criterion, loads its sub-filter group tree: the
        /// asx_nodefiltergroup owned by the criterion (asx_owningcriterion), plus any
        /// nested child groups (an EXISTS sub-filter may itself be an AND/OR tree of
        /// scalar criteria), plus all of those groups' criteria. It then wires the root
        /// sub-filter group onto its owning criterion so the mapper can find it.
        /// </summary>
        private static void LoadExistsSubFilters(IOrganizationService service, List<Entity> filterCriteria)
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

            var rootSubFilterGroups = service.RetrieveMultiple(subFilterGroupQuery).Entities.ToList();
            if (!rootSubFilterGroups.Any()) return;

            // Breadth-first descend the sub-filter's own AND/OR tree via ParentFilterGroup:
            // it is not scoped to a condition group, so it cannot be picked up with the owner's groups.
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
                var children = service.RetrieveMultiple(childQuery).Entities.ToList();
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

            var subCriteria = service.RetrieveMultiple(subCriterionQuery).Entities.ToList();

            WireFilterCriteriaToFilterGroups(subFilterGroups, subCriteria);
            WireChildFilterGroupsToParents(subFilterGroups);
            WireSubFilterGroupsToOwningCriteria(existsCriteria, rootSubFilterGroups);
        }

        private static void WireSubFilterGroupsToOwningCriteria(List<Entity> existsCriteria, List<Entity> rootSubFilterGroups)
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

        private static void WireFilterCriteriaToFilterGroups(List<Entity> filterGroups, List<Entity> filterCriteria)
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

        private static void WireChildFilterGroupsToParents(List<Entity> filterGroups)
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
    }
}
