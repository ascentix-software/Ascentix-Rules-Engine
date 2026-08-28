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
    public class RuleLoaderChannelTests
    {
        private static Entity Rule(string table, int[] triggers, int[] channels)
        {
            var e = new Entity(SchemaNames.Qualify(SchemaNames.Rule.Entity), Guid.NewGuid());
            e[SchemaNames.Qualify(SchemaNames.Rule.TableLogicalName)] = table;
            e["statuscode"] = new OptionSetValue((int)RuleStatus.Published);
            e[SchemaNames.Qualify(SchemaNames.Rule.Triggers)] =
                new OptionSetValueCollection(triggers.Select(t => new OptionSetValue(t)).ToList());
            if (channels != null)
                e[SchemaNames.Qualify(SchemaNames.Rule.Channels)] =
                    new OptionSetValueCollection(channels.Select(c => new OptionSetValue(c)).ToList());
            return e;
        }

        [Fact]
        public void LoadRules_filters_by_trigger_and_channel()
        {
            var context = new XrmFakedContext();
            context.Initialize(new List<Entity>
            {
                Rule("account", new[]{(int)RuleTrigger.OnCreate}, null),                                  // empty channels → included
                Rule("account", new[]{(int)RuleTrigger.OnCreate}, new[]{(int)RuleChannel.Standard}),   // included
                Rule("account", new[]{(int)RuleTrigger.OnCreate}, new[]{(int)RuleChannel.Portal}),     // excluded (wrong channel)
                Rule("account", new[]{(int)RuleTrigger.OnUpdate}, new[]{(int)RuleChannel.Standard}),   // excluded (wrong trigger)
            });
            var service = context.GetOrganizationService();

            var rules = new RuleLoader(service)
                .LoadRules("account", RuleTrigger.OnCreate, RuleChannel.Standard);

            Assert.Equal(2, rules.Count);
        }
    }
}
