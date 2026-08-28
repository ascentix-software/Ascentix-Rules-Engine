using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ConditionMapperFieldRefTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        [Fact]
        public void Maps_field_reference_source_node_and_column_onto_the_condition()
        {
            var ruleId = Guid.NewGuid();
            var rootCfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();

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
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "actualend",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.GreaterThanOrEqual),
                    [Q(SchemaNames.RuleCondition.ComparisonValueSource)] = new OptionSetValue((int)ComparisonValueSource.FieldReference),
                    [Q(SchemaNames.RuleCondition.ComparisonValueColumn)] = "actualstart",
                },
            });

            var rules = new RuleLoader(ctx.GetOrganizationService()).LoadRules("account");
            var groups = new ConditionGroupMapper().MapConditionGroups(rules);
            var condition = groups.Single().Conditions.Single();

            Assert.Equal(ComparisonValueSource.FieldReference, condition.ValueSource);
            Assert.Null(condition.ComparisonValueNodeId);              // same-record
            Assert.Equal("actualstart", condition.ComparisonValueColumn);
        }

        [Fact]
        public void Existing_condition_with_no_source_defaults_to_literal()
        {
            var ruleId = Guid.NewGuid();
            var rootCfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();

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
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                    [Q(SchemaNames.RuleCondition.ComparisonValue)] = "Valid",
                },
            });

            var rules = new RuleLoader(ctx.GetOrganizationService()).LoadRules("account");
            var condition = new ConditionGroupMapper().MapConditionGroups(rules).Single().Conditions.Single();

            Assert.Equal(ComparisonValueSource.Literal, condition.ValueSource);
            Assert.Equal("Valid", condition.ComparisonValue);
        }

        [Fact]
        public void Maps_cross_node_reference_and_collects_the_rhs_node_for_loading()
        {
            var ruleId = Guid.NewGuid();
            var rootCfgId = Guid.NewGuid();
            var lookupCfgId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var condId = Guid.NewGuid();

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), lookupCfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "contact",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfgId),
                    [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "primarycontactid",
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
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "ownerid",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                    [Q(SchemaNames.RuleCondition.ComparisonValueSource)] = new OptionSetValue((int)ComparisonValueSource.FieldReference),
                    [Q(SchemaNames.RuleCondition.ComparisonValueNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), lookupCfgId),
                    [Q(SchemaNames.RuleCondition.ComparisonValueColumn)] = "ownerid",
                },
            });

            var rules = new RuleLoader(ctx.GetOrganizationService()).LoadRules("account");
            var mapper = new ConditionGroupMapper();

            var groups = mapper.MapConditionGroups(rules);
            var condition = groups.Single().Conditions.Single();
            Assert.Equal(lookupCfgId, condition.ComparisonValueNodeId);   // cross-node ref mapped

            var referenced = RuleReferences.Compute(groups, null).NodeIds(ReferenceKind.FieldReferenceNodes);
            Assert.Contains(lookupCfgId, referenced);                     // RHS node collected for loading
        }
    }
}
