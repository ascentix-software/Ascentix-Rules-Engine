using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests.Engine
{
    /// <summary>
    /// End-to-end through <see cref="RulesEngineRunner.Run"/>: a {node:guid.col}
    /// token only renders when its node is actually loaded and queried, so these two facts prove
    /// the GATHER stage seeds message-template node refs (and every localized variant's) into
    /// the plan and the pushdown demand set: a node NOTHING but a Block/ShowMessage message
    /// references is still fetched. Before that seeding existed the message rendered blank.
    /// Rendering itself (root tokens, localized text, the degrade-to-raw paths and their trace
    /// shape) is a verdict of the evaluation seam and lives in RuleEvaluationTableTests.
    /// </summary>
    public class DynamicMessageTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private static RuleEvaluationOutcome Run(XrmFakedContext ctx, Entity overlay, ITracingService trace, int languageId = 1033)
        {
            var service = ctx.GetOrganizationService();
            return new RulesEngineRunner().Run(
                systemService: service,
                userService: service,
                logicalName: "account",
                inputs: new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                trigger: RuleTrigger.Manual,
                channel: RuleChannel.Standard,
                languageId: languageId,
                buildMode: RootBuildMode.UseTarget,
                trace: trace);
        }

        /// <summary>root account → lookup contact (primarycontactid). The rule's one condition
        /// is on the ROOT; the lookup node is referenced only by the ShowMessage text.</summary>
        private static (List<Entity> entities, Guid lookupCfg) SeedWithLookupNode(
            string messageTemplate, Guid contactId, Dictionary<int, string> localized = null)
        {
            var ids = (rule: Guid.NewGuid(), rootCfg: Guid.NewGuid(), lookupCfg: Guid.NewGuid(),
                       grp: Guid.NewGuid(), cond: Guid.NewGuid(), showAct: Guid.NewGuid());

            var rootTableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.rootCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            var lookupTableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.lookupCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "contact",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.rootCfg),
                [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "primarycontactid",
                [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "contactid",
            };
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ids.rule)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.Manual) }),
            };
            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
            };
            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), ids.cond)
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.rootCfg),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                [Q(SchemaNames.RuleCondition.ComparisonValue)] = "Acme",
            };
            var showAction = new Entity(Q(SchemaNames.RuleAction.Entity), ids.showAct)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.ShowMessage),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                [Q(SchemaNames.RuleAction.Message)] = messageTemplate.Replace("{lookupCfg}", ids.lookupCfg.ToString()),
                [Q(SchemaNames.RuleAction.Order)] = 1,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };
            var contact = new Entity("contact", contactId) { ["fullname"] = "Sam Roe" };

            var entities = new List<Entity> { rootTableConfig, lookupTableConfig, rule, group, condition, showAction, contact };

            if (localized != null)
                foreach (var kvp in localized)
                    entities.Add(new Entity(Q(SchemaNames.LocalizedMessage.Entity), Guid.NewGuid())
                    {
                        [Q(SchemaNames.LocalizedMessage.RuleAction)] = new EntityReference(Q(SchemaNames.RuleAction.Entity), ids.showAct),
                        [Q(SchemaNames.LocalizedMessage.LanguageCode)] = kvp.Key,
                        [Q(SchemaNames.LocalizedMessage.Message)] = kvp.Value.Replace("{lookupCfg}", ids.lookupCfg.ToString()),
                    });

            return (entities, ids.lookupCfg);
        }

        private static Entity AcmeWithContact(Guid contactId) => new Entity("account", Guid.NewGuid())
        {
            ["name"] = "Acme",
            ["primarycontactid"] = new EntityReference("contact", contactId),
        };

        // The fix: nothing but the message references the lookup node, no condition, no action
        // target, no mapping. Before message-token seeding the node was never planned or fetched
        // and the token rendered "" (Message == "Contact: ."), with nothing traced.
        [Fact]
        public void Node_token_renders_when_nothing_but_the_message_references_the_node()
        {
            var contactId = Guid.NewGuid();
            var (entities, _) = SeedWithLookupNode("Contact: {node:{lookupCfg}.fullname}.", contactId);
            var ctx = new XrmFakedContext();
            ctx.Initialize(entities);

            var outcome = Run(ctx, AcmeWithContact(contactId), new XrmFakedTracingService());

            var showFired = outcome.Records.Single().FiredActions.Single(a => a.ActionType == ActionType.ShowMessage);
            Assert.Equal("Contact: Sam Roe.", showFired.Message);
        }

        [Fact]
        public void Localized_node_token_renders_when_only_the_localized_message_references_the_node()
        {
            // The base message has no node token; only the French variant does. The localized
            // variants are seeded too, so the node is fetched for the caller's language.
            var contactId = Guid.NewGuid();
            var (entities, _) = SeedWithLookupNode("Contact on file.", contactId,
                localized: new Dictionary<int, string> { [1036] = "Contact : {node:{lookupCfg}.fullname}." });
            var ctx = new XrmFakedContext();
            ctx.Initialize(entities);

            var outcome = Run(ctx, AcmeWithContact(contactId), new XrmFakedTracingService(), languageId: 1036);

            var showFired = outcome.Records.Single().FiredActions.Single(a => a.ActionType == ActionType.ShowMessage);
            Assert.Equal("Contact : Sam Roe.", showFired.Message);
        }
    }
}
