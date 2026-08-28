using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleActionLoaderLocalizationTests
    {
        private static Entity Action(Guid ruleId, Guid actionId)
        {
            var e = new Entity(SchemaNames.Qualify(SchemaNames.RuleAction.Entity), actionId);
            e[SchemaNames.Qualify(SchemaNames.RuleAction.Rule)] =
                new EntityReference(SchemaNames.Qualify(SchemaNames.Rule.Entity), ruleId);
            e[SchemaNames.Qualify(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block);
            e[SchemaNames.Qualify(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnNoMatch);
            e[SchemaNames.Qualify(SchemaNames.RuleAction.Message)] = "Invalid.";
            e[SchemaNames.Qualify(SchemaNames.RuleAction.Order)] = 1;
            e[SchemaNames.Qualify(SchemaNames.RuleAction.IsActive)] = true;
            return e;
        }

        private static Entity Localized(Guid actionId, int lcid, string text)
        {
            var e = new Entity(SchemaNames.Qualify(SchemaNames.LocalizedMessage.Entity), Guid.NewGuid());
            e[SchemaNames.Qualify(SchemaNames.LocalizedMessage.RuleAction)] =
                new EntityReference(SchemaNames.Qualify(SchemaNames.RuleAction.Entity), actionId);
            e[SchemaNames.Qualify(SchemaNames.LocalizedMessage.LanguageCode)] = lcid;
            e[SchemaNames.Qualify(SchemaNames.LocalizedMessage.Message)] = text;
            return e;
        }

        [Fact]
        public void LoadActionsByRule_fills_localized_messages()
        {
            var ruleId = Guid.NewGuid();
            var actionId = Guid.NewGuid();
            var context = new XrmFakedContext();
            context.Initialize(new List<Entity>
            {
                Action(ruleId, actionId),
                Localized(actionId, 1036, "Nom invalide."),
                Localized(actionId, 3084, "Nom invalide (CA)."),
            });
            var service = context.GetOrganizationService();

            var loaded = new RuleActionLoader(service).LoadActionsByRule(new[] { ruleId });
            var action = loaded[ruleId][0];

            Assert.Equal("Nom invalide.", action.LocalizedMessages[1036]);
            Assert.Equal("Nom invalide (CA).", action.LocalizedMessages[3084]);
            Assert.Equal("Invalid.", action.Message);
        }

        [Fact]
        public void LoadActionsByRule_no_localized_rows_leaves_empty_dictionary()
        {
            var ruleId = Guid.NewGuid();
            var context = new XrmFakedContext();
            context.Initialize(new List<Entity> { Action(ruleId, Guid.NewGuid()) });
            var service = context.GetOrganizationService();

            var action = new RuleActionLoader(service).LoadActionsByRule(new[] { ruleId })[ruleId][0];
            Assert.Empty(action.LocalizedMessages);
        }
    }
}
