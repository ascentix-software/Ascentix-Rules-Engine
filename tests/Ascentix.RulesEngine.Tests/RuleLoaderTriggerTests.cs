using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleLoaderTriggerTests
    {
        private static Entity Rule(string table, bool active, params int[] triggers)
        {
            var e = new Entity(SchemaNames.Qualify(SchemaNames.Rule.Entity), Guid.NewGuid());
            e[SchemaNames.Qualify(SchemaNames.Rule.TableLogicalName)] = table;
            e["statuscode"] = new OptionSetValue(active ? (int)RuleStatus.Published : (int)RuleStatus.Draft);
            e[SchemaNames.Qualify(SchemaNames.Rule.Triggers)] =
                new OptionSetValueCollection(triggers.Select(t => new OptionSetValue(t)).ToList());
            return e;
        }

        [Fact]
        public void LoadRules_with_trigger_returns_only_rules_tagged_for_that_trigger()
        {
            var context = new XrmFakedContext();
            context.Initialize(new List<Entity>
            {
                Rule("account", true, (int)RuleTrigger.OnCreate),                       // included
                Rule("account", true, (int)RuleTrigger.OnForm, (int)RuleTrigger.Manual), // excluded (no OnSave)
                Rule("account", true, (int)RuleTrigger.OnCreate, (int)RuleTrigger.OnForm),  // included
            });
            var service = context.GetOrganizationService();

            var rules = new RuleLoader(service).LoadRules("account", RuleTrigger.OnCreate);

            Assert.Equal(2, rules.Count);
        }
    }
}
