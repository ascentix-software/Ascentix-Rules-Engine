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
    public class RuleLoaderStatusTests
    {
        private static Entity Rule(string table, RuleStatus status)
        {
            var e = new Entity(SchemaNames.Qualify(SchemaNames.Rule.Entity), Guid.NewGuid());
            e[SchemaNames.Qualify(SchemaNames.Rule.TableLogicalName)] = table;
            e["statuscode"] = new OptionSetValue((int)status);
            e[SchemaNames.Qualify(SchemaNames.Rule.Triggers)] =
                new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) });
            return e;
        }

        [Fact]
        public void Only_published_rules_load()
        {
            var context = new XrmFakedContext();
            context.Initialize(new List<Entity>
            {
                Rule("account", RuleStatus.Published),
                Rule("account", RuleStatus.Draft),
                Rule("account", RuleStatus.Archived),
            });
            var rules = new RuleLoader(context.GetOrganizationService()).LoadRules("account");
            Assert.Single(rules);
        }
    }
}
