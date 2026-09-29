using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleActionLoaderRowFilterTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);
        private static EntityReference Ref(string fragment, Guid id) => new EntityReference(Q(fragment), id);

        private readonly Guid _rule = Guid.NewGuid(), _action = Guid.NewGuid(), _node = Guid.NewGuid(), _tasks = Guid.NewGuid();
        private readonly Guid _rootGroup = Guid.NewGuid(), _childGroup = Guid.NewGuid(), _existsCrit = Guid.NewGuid(), _subGroup = Guid.NewGuid();

        private List<Entity> Seed() => new List<Entity>
        {
            new Entity(Q(SchemaNames.Rule.Entity), _rule) { [Q(SchemaNames.Rule.TableLogicalName)] = "account" },
            new Entity(Q(SchemaNames.RuleAction.Entity), _action)
            {
                [Q(SchemaNames.RuleAction.Rule)] = Ref(SchemaNames.Rule.Entity, _rule),
                [Q(SchemaNames.PrimaryName)] = "Stop bulk email",
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.UpdateRecord),
                [Q(SchemaNames.RuleAction.TargetNode)] = Ref(SchemaNames.TableConfig.Entity, _node),
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            },
            new Entity(Q(SchemaNames.NodeFilterGroup.Entity), _rootGroup)
            {
                [Q(SchemaNames.NodeFilterGroup.RuleAction)] = Ref(SchemaNames.RuleAction.Entity, _action),
                [Q(SchemaNames.NodeFilterGroup.TableConfigNode)] = Ref(SchemaNames.TableConfig.Entity, _node),
                [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
            },
            new Entity(Q(SchemaNames.NodeFilterGroup.Entity), _childGroup)
            {
                [Q(SchemaNames.NodeFilterGroup.RuleAction)] = Ref(SchemaNames.RuleAction.Entity, _action),
                [Q(SchemaNames.NodeFilterGroup.TableConfigNode)] = Ref(SchemaNames.TableConfig.Entity, _node),
                [Q(SchemaNames.NodeFilterGroup.ParentFilterGroup)] = Ref(SchemaNames.NodeFilterGroup.Entity, _rootGroup),
                [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.Or),
            },
            new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = Ref(SchemaNames.NodeFilterGroup.Entity, _rootGroup),
                [Q(SchemaNames.NodeFilterCriterion.FieldName)] = "statecode",
                [Q(SchemaNames.NodeFilterCriterion.Operator)] = "eq",
                [Q(SchemaNames.NodeFilterCriterion.Value)] = "0",
            },
            new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), _existsCrit)
            {
                [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = Ref(SchemaNames.NodeFilterGroup.Entity, _childGroup),
                [Q(SchemaNames.NodeFilterCriterion.CriterionType)] = new OptionSetValue((int)CriterionKind.Exists),
                [Q(SchemaNames.NodeFilterCriterion.CollectionNode)] = Ref(SchemaNames.TableConfig.Entity, _tasks),
                [Q(SchemaNames.NodeFilterCriterion.MaxCount)] = 0,
            },
            new Entity(Q(SchemaNames.NodeFilterGroup.Entity), _subGroup)
            {
                [Q(SchemaNames.NodeFilterGroup.OwningCriterion)] = Ref(SchemaNames.NodeFilterCriterion.Entity, _existsCrit),
                [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
            },
            new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = Ref(SchemaNames.NodeFilterGroup.Entity, _subGroup),
                [Q(SchemaNames.NodeFilterCriterion.FieldName)] = "subject",
                [Q(SchemaNames.NodeFilterCriterion.Operator)] = "like",
                [Q(SchemaNames.NodeFilterCriterion.Value)] = "Credit hold%",
            },
        };

        private void AssertLoaded(RuleAction action)
        {
            Assert.Equal("Stop bulk email", action.Name);
            var filter = action.RowFilter;
            Assert.NotNull(filter);
            Assert.Equal(_rootGroup, filter.Id);
            Assert.Equal(_action, filter.RuleActionId);
            Assert.Equal(_node, filter.TableConfigNodeId);
            Assert.Equal("statecode", filter.Criteria.Single().FieldName);
            var child = filter.ChildGroups.Single();
            Assert.Equal(LogicalOperator.Or, child.LogicalOperator);
            var exists = child.Criteria.Single();
            Assert.Equal(CriterionKind.Exists, exists.Kind);
            Assert.Equal("subject", exists.SubFilter.Criteria.Single().FieldName);
        }

        [Fact]
        public void An_actions_rows_filter_loads_with_nested_groups_and_exists_sub_filters()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());
            AssertLoaded(new RuleActionLoader(ctx.GetOrganizationService()).LoadActionsByRule(new[] { _rule })[_rule].Single());
        }

        [Fact]
        public void A_published_revision_carries_the_rows_filter()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());
            var service = ctx.GetOrganizationService();
            var snapshot = RuleSnapshot.Capture(service, service.Retrieve(Q(SchemaNames.Rule.Entity), _rule, new Microsoft.Xrm.Sdk.Query.ColumnSet(true)), includeConfigs: false);

            Assert.Contains(snapshot.Rows, r => r.Entity == Q(SchemaNames.NodeFilterGroup.Entity) && r.Id == _rootGroup);
            var frozen = new SnapshotService(service, snapshot);
            AssertLoaded(new RuleActionLoader(frozen).LoadActionsByRule(new[] { _rule })[_rule].Single());
        }

        [Fact]
        public void Two_top_level_groups_on_one_action_are_refused()
        {
            var seed = Seed();
            seed.Add(new Entity(Q(SchemaNames.NodeFilterGroup.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.NodeFilterGroup.RuleAction)] = Ref(SchemaNames.RuleAction.Entity, _action),
                [Q(SchemaNames.NodeFilterGroup.TableConfigNode)] = Ref(SchemaNames.TableConfig.Entity, _node),
                [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
            });
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                new RuleActionLoader(ctx.GetOrganizationService()).LoadActionsByRule(new[] { _rule }));
            Assert.Contains("more than one Rows filter group", ex.Message);
        }
    }
}
