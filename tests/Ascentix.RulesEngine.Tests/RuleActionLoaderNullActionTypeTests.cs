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
    public class RuleActionLoaderNullActionTypeTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        [Fact]
        public void Null_actiontype_maps_without_NRE()
        {
            var ruleId = Guid.NewGuid();
            var action = new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                // asx_actiontype and asx_actionfireon deliberately omitted (null)
                [Q(SchemaNames.RuleAction.Order)] = 1,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { action });

            var byRule = new RuleActionLoader(ctx.GetOrganizationService())
                .LoadActionsByRule(new[] { ruleId });

            var mapped = byRule[ruleId].Single();
            Assert.Equal(0, (int)mapped.ActionType);
            Assert.Equal(0, (int)mapped.FireOn);
        }
    }
}
