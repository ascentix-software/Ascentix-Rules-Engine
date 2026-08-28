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
    public class RuleLoaderByIdTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        [Fact]
        public void Loads_a_draft_rule_by_id_with_its_groups()
        {
            var ruleId = Guid.NewGuid();
            var grpId = Guid.NewGuid();
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ruleId)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Draft), // NOT Published
            };
            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), grpId)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { rule, group });

            var loaded = new RuleLoader(ctx.GetOrganizationService()).LoadRuleById(ruleId);

            Assert.Single(loaded);
            Assert.Equal(ruleId, loaded[0].Id);
            var rel = new Relationship(SchemaNames.Qualify(SchemaNames.Relationships.RuleConditionGroup));
            Assert.True(loaded[0].RelatedEntities.Contains(rel));
        }

        [Fact]
        public void Returns_empty_when_rule_absent()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>());
            var loaded = new RuleLoader(ctx.GetOrganizationService()).LoadRuleById(Guid.NewGuid());
            Assert.Empty(loaded);
        }
    }
}
