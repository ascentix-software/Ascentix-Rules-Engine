using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Covers RuleLoader + ConditionGroupMapper for an EXISTS node-filter criterion loaded
    /// from raw asx_nodefiltercriterion / asx_nodefiltergroup records. The sub-filter group is
    /// owned by the criterion (asx_owningcriterion), NOT scoped to the condition group, so
    /// RuleLoader must retrieve it via a separate query (see RuleLoader.LoadExistsSubFilters)
    /// and wire it onto the criterion for ConditionGroupMapper.MapFilterCriteria to assemble.
    /// </summary>
    public class ConditionMapperExistsCriterionTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        [Fact]
        public void Maps_exists_criterion_with_assembled_sub_filter_from_records()
        {
            var ruleId = Guid.NewGuid();
            var rootCfgId = Guid.NewGuid();
            var childCfgId = Guid.NewGuid();
            var collectionCfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();
            var filterGroupId = Guid.NewGuid();
            var existsCriterionId = Guid.NewGuid();
            var subFilterGroupId = Guid.NewGuid();
            var subCriterionId = Guid.NewGuid();

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), childCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), collectionCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_shipment",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_shipmentorderid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_order",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), condId)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), childCfgId),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.RowCount),
                    [Q(SchemaNames.RuleCondition.MinExpectedRows)] = 1,
                },
                // Top-level node filter group, scoped to the condition group and owned by
                // the condition, targeting the child ("line") node.
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), filterGroupId)
                {
                    [Q(SchemaNames.NodeFilterGroup.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.NodeFilterGroup.TableConfigNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), childCfgId),
                    [Q(SchemaNames.NodeFilterGroup.RuleCondition)] = new EntityReference(Q(SchemaNames.RuleCondition.Entity), condId),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                },
                // The EXISTS criterion: collection = shipment, min count 1.
                new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), existsCriterionId)
                {
                    [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), filterGroupId),
                    [Q(SchemaNames.NodeFilterCriterion.CriterionType)] = new OptionSetValue((int)CriterionKind.Exists),
                    [Q(SchemaNames.NodeFilterCriterion.CollectionNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), collectionCfgId),
                    [Q(SchemaNames.NodeFilterCriterion.MinCount)] = 1,
                },
                // Sub-filter group owned by the EXISTS criterion (asx_owningcriterion),
                // NOT scoped to the condition group (no asx_conditiongroup set).
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), subFilterGroupId)
                {
                    [Q(SchemaNames.NodeFilterGroup.OwningCriterion)] = new EntityReference(Q(SchemaNames.NodeFilterCriterion.Entity), existsCriterionId),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                },
                // Scalar sub-criterion inside the sub-filter: statuscode eq expedited.
                new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), subCriterionId)
                {
                    [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), subFilterGroupId),
                    [Q(SchemaNames.NodeFilterCriterion.FieldName)] = "statuscode",
                    [Q(SchemaNames.NodeFilterCriterion.Operator)] = "eq",
                    [Q(SchemaNames.NodeFilterCriterion.Value)] = "expedited",
                },
            });

            var rules = new RuleLoader(ctx.GetOrganizationService()).LoadRules("sample_order");
            var groups = new ConditionGroupMapper().MapConditionGroups(rules);
            var filterGroup = groups.Single().NodeFilterGroups.Single();
            var criterion = filterGroup.Criteria.Single();

            Assert.Equal(CriterionKind.Exists, criterion.Kind);
            Assert.Equal(collectionCfgId, criterion.CollectionNodeId);
            Assert.Equal(1, criterion.MinCount);
            Assert.Null(criterion.MaxCount);

            Assert.NotNull(criterion.SubFilter);
            var subCriterion = criterion.SubFilter.Criteria.Single();
            Assert.Equal(CriterionKind.Comparison, subCriterion.Kind);
            Assert.Equal("statuscode", subCriterion.FieldName);
            Assert.Equal("eq", subCriterion.Operator);
            Assert.Equal("expedited", subCriterion.Value);
        }

        [Fact]
        public void Comparison_criterion_has_no_exists_fields_back_compat()
        {
            var ruleId = Guid.NewGuid();
            var rootCfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();
            var filterGroupId = Guid.NewGuid();
            var criterionId = Guid.NewGuid();

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), condId)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "creditlimit",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.GreaterThan),
                },
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), filterGroupId)
                {
                    [Q(SchemaNames.NodeFilterGroup.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.NodeFilterGroup.TableConfigNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    // No asx_criteriontype set anywhere below: proves legacy rows still map to Comparison.
                },
                new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), criterionId)
                {
                    [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), filterGroupId),
                    [Q(SchemaNames.NodeFilterCriterion.FieldName)] = "industry",
                    [Q(SchemaNames.NodeFilterCriterion.Operator)] = "eq",
                    [Q(SchemaNames.NodeFilterCriterion.Value)] = "Manufacturing",
                },
            });

            var rules = new RuleLoader(ctx.GetOrganizationService()).LoadRules("account");
            var groups = new ConditionGroupMapper().MapConditionGroups(rules);
            var criterion = groups.Single().NodeFilterGroups.Single().Criteria.Single();

            Assert.Equal(CriterionKind.Comparison, criterion.Kind);
            Assert.Null(criterion.CollectionNodeId);
            Assert.Null(criterion.MinCount);
            Assert.Null(criterion.MaxCount);
            Assert.Null(criterion.SubFilter);
        }

        /// <summary>
        /// Characterization test for RuleLoader.LoadExistsSubFilters' BFS descent (the same bug
        /// class 2fddfac fixed on the client): the sub-filter's own root group has a CHILD GROUP
        /// (an AND/OR group nested via asx_parentfiltergroup, NOT a nested EXISTS, which remains
        /// a non-goal and is now runtime-guarded) holding the actual scalar criterion. If the BFS
        /// loop only ever looks at the root frontier, the child group's criteria never get wired
        /// and this test fails.
        /// </summary>
        [Fact]
        public void Exists_criterion_with_nested_sub_filter_group_loads_the_full_tree()
        {
            var ruleId = Guid.NewGuid();
            var rootCfgId = Guid.NewGuid();
            var childCfgId = Guid.NewGuid();
            var collectionCfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();
            var filterGroupId = Guid.NewGuid();
            var existsCriterionId = Guid.NewGuid();
            var subFilterRootGroupId = Guid.NewGuid();
            var subFilterChildGroupId = Guid.NewGuid();
            var nestedCriterionId = Guid.NewGuid();

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), childCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), collectionCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_shipment",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_shipmentorderid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_order",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), condId)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), childCfgId),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.RowCount),
                    [Q(SchemaNames.RuleCondition.MinExpectedRows)] = 1,
                },
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), filterGroupId)
                {
                    [Q(SchemaNames.NodeFilterGroup.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.NodeFilterGroup.TableConfigNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), childCfgId),
                    [Q(SchemaNames.NodeFilterGroup.RuleCondition)] = new EntityReference(Q(SchemaNames.RuleCondition.Entity), condId),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                },
                new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), existsCriterionId)
                {
                    [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), filterGroupId),
                    [Q(SchemaNames.NodeFilterCriterion.CriterionType)] = new OptionSetValue((int)CriterionKind.Exists),
                    [Q(SchemaNames.NodeFilterCriterion.CollectionNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), collectionCfgId),
                    [Q(SchemaNames.NodeFilterCriterion.MinCount)] = 1,
                },
                // Root sub-filter group owned by the EXISTS criterion. It has NO criteria of its
                // own (everything lives one level down in its child group), so the BFS must
                // actually descend via asx_parentfiltergroup to find anything.
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), subFilterRootGroupId)
                {
                    [Q(SchemaNames.NodeFilterGroup.OwningCriterion)] = new EntityReference(Q(SchemaNames.NodeFilterCriterion.Entity), existsCriterionId),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                },
                // Child AND/OR group nested under the sub-filter root, NOT owned by any
                // criterion (asx_owningcriterion unset), only reachable via asx_parentfiltergroup.
                // This is a group nested inside a sub-filter, NOT a nested EXISTS.
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), subFilterChildGroupId)
                {
                    [Q(SchemaNames.NodeFilterGroup.ParentFilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), subFilterRootGroupId),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.Or),
                },
                // The actual scalar criterion, one level down in the nested child group.
                new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), nestedCriterionId)
                {
                    [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), subFilterChildGroupId),
                    [Q(SchemaNames.NodeFilterCriterion.FieldName)] = "statuscode",
                    [Q(SchemaNames.NodeFilterCriterion.Operator)] = "eq",
                    [Q(SchemaNames.NodeFilterCriterion.Value)] = "expedited",
                },
            });

            var rules = new RuleLoader(ctx.GetOrganizationService()).LoadRules("sample_order");
            var groups = new ConditionGroupMapper().MapConditionGroups(rules);
            var filterGroup = groups.Single().NodeFilterGroups.Single();
            var criterion = filterGroup.Criteria.Single();

            Assert.NotNull(criterion.SubFilter);
            Assert.Empty(criterion.SubFilter.Criteria);
            var childGroup = Assert.Single(criterion.SubFilter.ChildGroups);
            var nestedCriterion = Assert.Single(childGroup.Criteria);
            Assert.Equal(CriterionKind.Comparison, nestedCriterion.Kind);
            Assert.Equal("statuscode", nestedCriterion.FieldName);
            Assert.Equal("eq", nestedCriterion.Operator);
            Assert.Equal("expedited", nestedCriterion.Value);
        }

        /// <summary>
        /// Characterization test for the rootSubFilterGroups-empty early return in
        /// LoadExistsSubFilters: an EXISTS criterion with no asx_nodefiltergroup pointing at it
        /// via asx_owningcriterion should load with a null SubFilter, not throw.
        /// </summary>
        [Fact]
        public void Exists_criterion_with_no_sub_filter_groups_loads_a_null_sub_filter()
        {
            var ruleId = Guid.NewGuid();
            var rootCfgId = Guid.NewGuid();
            var childCfgId = Guid.NewGuid();
            var collectionCfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();
            var filterGroupId = Guid.NewGuid();
            var existsCriterionId = Guid.NewGuid();

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), childCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), collectionCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_shipment",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_shipmentorderid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_order",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), condId)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), childCfgId),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.RowCount),
                    [Q(SchemaNames.RuleCondition.MinExpectedRows)] = 1,
                },
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), filterGroupId)
                {
                    [Q(SchemaNames.NodeFilterGroup.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.NodeFilterGroup.TableConfigNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), childCfgId),
                    [Q(SchemaNames.NodeFilterGroup.RuleCondition)] = new EntityReference(Q(SchemaNames.RuleCondition.Entity), condId),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                },
                // EXISTS criterion with no asx_nodefiltergroup owned by it anywhere in the data:
                // rootSubFilterGroups comes back empty and LoadExistsSubFilters must return early.
                new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), existsCriterionId)
                {
                    [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), filterGroupId),
                    [Q(SchemaNames.NodeFilterCriterion.CriterionType)] = new OptionSetValue((int)CriterionKind.Exists),
                    [Q(SchemaNames.NodeFilterCriterion.CollectionNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), collectionCfgId),
                    [Q(SchemaNames.NodeFilterCriterion.MinCount)] = 1,
                },
            });

            var rules = new RuleLoader(ctx.GetOrganizationService()).LoadRules("sample_order");
            var groups = new ConditionGroupMapper().MapConditionGroups(rules);
            var criterion = groups.Single().NodeFilterGroups.Single().Criteria.Single();

            Assert.Equal(CriterionKind.Exists, criterion.Kind);
            Assert.Null(criterion.SubFilter);
        }

        /// <summary>
        /// WireSubFilterGroupsToOwningCriteria must not build its owner lookup with a bare
        /// .ToDictionary(...): that throws an undecorated ArgumentException ("An item with
        /// the same key has already been added") when two asx_nodefiltergroup records both set
        /// asx_owningcriterion to the same criterion. Nothing at load time prevents that data
        /// state, so the loader must guard it explicitly and name the offending criterion.
        /// </summary>
        [Fact]
        public void Two_sub_filter_groups_owned_by_one_criterion_fail_with_a_config_error()
        {
            var ruleId = Guid.NewGuid();
            var rootCfgId = Guid.NewGuid();
            var childCfgId = Guid.NewGuid();
            var collectionCfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();
            var filterGroupId = Guid.NewGuid();
            var existsCriterionId = Guid.NewGuid();
            var subFilterGroupAId = Guid.NewGuid();
            var subFilterGroupBId = Guid.NewGuid();

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), childCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), collectionCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_shipment",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_shipmentorderid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_order",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), condId)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), childCfgId),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.RowCount),
                    [Q(SchemaNames.RuleCondition.MinExpectedRows)] = 1,
                },
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), filterGroupId)
                {
                    [Q(SchemaNames.NodeFilterGroup.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grpId),
                    [Q(SchemaNames.NodeFilterGroup.TableConfigNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), childCfgId),
                    [Q(SchemaNames.NodeFilterGroup.RuleCondition)] = new EntityReference(Q(SchemaNames.RuleCondition.Entity), condId),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                },
                new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), existsCriterionId)
                {
                    [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), filterGroupId),
                    [Q(SchemaNames.NodeFilterCriterion.CriterionType)] = new OptionSetValue((int)CriterionKind.Exists),
                    [Q(SchemaNames.NodeFilterCriterion.CollectionNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), collectionCfgId),
                    [Q(SchemaNames.NodeFilterCriterion.MinCount)] = 1,
                },
                // Two sub-filter groups both claim the same owning criterion, a data state
                // nothing at load time prevents.
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), subFilterGroupAId)
                {
                    [Q(SchemaNames.NodeFilterGroup.OwningCriterion)] = new EntityReference(Q(SchemaNames.NodeFilterCriterion.Entity), existsCriterionId),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                },
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), subFilterGroupBId)
                {
                    [Q(SchemaNames.NodeFilterGroup.OwningCriterion)] = new EntityReference(Q(SchemaNames.NodeFilterCriterion.Entity), existsCriterionId),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.Or),
                },
            });

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => new RuleLoader(ctx.GetOrganizationService()).LoadRules("sample_order"));

            Assert.Contains("owning criterion", ex.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Contains(existsCriterionId.ToString(), ex.Message);
        }
    }
}
