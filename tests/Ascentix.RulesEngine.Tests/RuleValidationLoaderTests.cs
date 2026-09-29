using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Validation;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleValidationLoaderTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        [Fact]
        public void Builds_aggregate_with_primary_table_groups_and_actions()
        {
            var ruleId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var actId = Guid.NewGuid();
            var seed = new List<Entity>
            {
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Draft),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleAction.Entity), actId)
                {
                    [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                    [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnNoMatch),
                    [Q(SchemaNames.RuleAction.Message)] = "x",
                    [Q(SchemaNames.RuleAction.Order)] = 1,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                },
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);

            var model = RuleValidationLoader.Load(ctx.GetOrganizationService(), ruleId);

            Assert.NotNull(model);
            Assert.Equal("account", model.PrimaryTable);
            Assert.Single(model.Groups);
            Assert.Single(model.Actions);
            Assert.Single(model.AllGroups());
        }

        [Fact]
        public void A_create_per_row_target_is_in_the_validated_config_set_and_a_stale_create_target_is_not()
        {
            // Nothing else names either node, so only the Create-target classification brings the
            // collection in (the set checks need it) and keeps the stale lookup out.
            var ruleId = Guid.NewGuid(); var rootId = Guid.NewGuid(); var contactsId = Guid.NewGuid(); var ownerId = Guid.NewGuid();
            Entity Node(Guid id, string table, TableConfigType type, Guid? parent) => new Entity(Q(SchemaNames.TableConfig.Entity), id)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = table,
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)type),
                [Q(SchemaNames.TableConfig.ParentTable)] = parent.HasValue ? new EntityReference(Q(SchemaNames.TableConfig.Entity), parent.Value) : null,
            };
            Entity Create(Guid target) => new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.CreateRecord),
                [Q(SchemaNames.RuleAction.TargetTable)] = "task",
                [Q(SchemaNames.RuleAction.TargetNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), target),
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.Rule.Entity), ruleId) { [Q(SchemaNames.Rule.TableLogicalName)] = "account" },
                Node(rootId, "account", TableConfigType.RootTable, null),
                Node(contactsId, "contact", TableConfigType.ChildTable, rootId),
                Node(ownerId, "systemuser", TableConfigType.LookupTable, rootId),
                Create(contactsId), Create(ownerId),
            });

            var model = RuleValidationLoader.Load(ctx.GetOrganizationService(), ruleId);

            Assert.True(model.Configs.Contains(contactsId));
            Assert.False(model.Configs.Contains(ownerId));
        }

        [Fact]
        public void Returns_null_when_rule_absent()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>());
            Assert.Null(RuleValidationLoader.Load(ctx.GetOrganizationService(), Guid.NewGuid()));
        }
    }
}
