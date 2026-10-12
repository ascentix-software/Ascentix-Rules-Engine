using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Plugin.DataUpdates;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;
using Ascentix.RulesEngine.Core.Publication;

namespace Ascentix.RulesEngine.Tests
{
    public class RulePublishPluginTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // An invalid rule = exists but has no conditions/actions.
        private static Entity SeedInvalidRule(Guid ruleId) => new Entity(Q(SchemaNames.Rule.Entity), ruleId)
        {
            [Q(SchemaNames.Rule.TableLogicalName)] = "account",
            ["statuscode"] = new OptionSetValue((int)RuleStatus.Draft),
        };

        private static XrmFakedPluginExecutionContext UpdateContext(Entity target, OptionSetValue preStatus)
        {
            var preImage = new Entity(Q(SchemaNames.Rule.Entity), target.Id) { ["statuscode"] = preStatus };
            return new XrmFakedPluginExecutionContext
            {
                MessageName = "Update",
                Stage = 20, // pre-operation
                PrimaryEntityName = Q(SchemaNames.Rule.Entity),
                InputParameters = new ParameterCollection { { "Target", target } },
                PreEntityImages = new EntityImageCollection { { "PreImage", preImage } },
            };
        }

        [Fact]
        public void Draft_to_published_invalid_rule_throws()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { SeedInvalidRule(ruleId), new Entity(PublicationSchema.Lock, PublicationSchema.LockId) });

            var target = new Entity(Q(SchemaNames.Rule.Entity), ruleId) { ["statuscode"] = new OptionSetValue((int)RuleStatus.Published) };
            var pctx = UpdateContext(target, new OptionSetValue((int)RuleStatus.Draft));

            Assert.Throws<InvalidPluginExecutionException>(() => ctx.ExecutePluginWith<RulePublishPlugin>(pctx));
        }

        [Fact]
        public void Draft_save_of_invalid_rule_does_not_throw()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { SeedInvalidRule(ruleId) });

            // statuscode not in Target → not a publish transition
            var target = new Entity(Q(SchemaNames.Rule.Entity), ruleId) { [Q(SchemaNames.Rule.TableLogicalName)] = "account" };
            var pctx = UpdateContext(target, new OptionSetValue((int)RuleStatus.Draft));

            ctx.ExecutePluginWith<RulePublishPlugin>(pctx); // no throw
        }

        [Fact]
        public void Already_published_status_write_validates_a_new_revision()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { SeedInvalidRule(ruleId), new Entity(PublicationSchema.Lock, PublicationSchema.LockId) });

            var target = new Entity(Q(SchemaNames.Rule.Entity), ruleId) { ["statuscode"] = new OptionSetValue((int)RuleStatus.Published) };
            var pctx = UpdateContext(target, new OptionSetValue((int)RuleStatus.Published)); // old already Published

            Assert.Throws<InvalidPluginExecutionException>(() => ctx.ExecutePluginWith<RulePublishPlugin>(pctx));
        }

        [Fact]
        public void Publish_with_absent_preimage_still_gates_invalid_rule()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { SeedInvalidRule(ruleId), new Entity(PublicationSchema.Lock, PublicationSchema.LockId) });

            var target = new Entity(Q(SchemaNames.Rule.Entity), ruleId) { ["statuscode"] = new OptionSetValue((int)RuleStatus.Published) };
            var pctx = new XrmFakedPluginExecutionContext
            {
                MessageName = "Update",
                Stage = 20, // pre-operation
                PrimaryEntityName = Q(SchemaNames.Rule.Entity),
                InputParameters = new ParameterCollection { { "Target", target } },
                PreEntityImages = new EntityImageCollection(), // Empty: absent PreImage
            };

            Assert.Throws<InvalidPluginExecutionException>(() => ctx.ExecutePluginWith<RulePublishPlugin>(pctx));
        }

        // The data update publish gate (docs/Schema.md §5.1), given its updates through the test seam.
        private sealed class PendingUpdate : IDataUpdate
        {
            public int Number => 1;
            public string Title => "Convert";
            public bool IsNeeded(IOrganizationService system) => Needed;
            public bool Needed { get; set; } = true;
            public DataUpdateStep RunStep(DataUpdateContext context, string cursor, Func<bool> overBudget) => new DataUpdateStep(cursor, true, 0);
            public string Skip(string cursor, string item) => cursor;
        }

        private static readonly IReadOnlyList<IDataUpdate> OneUpdate = new IDataUpdate[] { new PendingUpdate() };

        // A valid, never-published rule: the publish stores its first revision on the target.
        private static (TransactionalPluginContext Context, Entity Target, XrmFakedPluginExecutionContext Request) FirstPublish()
        {
            var id = Guid.NewGuid();
            var context = RuleRevisionTests.Context(RuleRevisionTests.Rule(id));
            var target = new Entity("asx_rule", id) { ["statuscode"] = new OptionSetValue((int)RuleStatus.Published) };
            var request = new XrmFakedPluginExecutionContext { MessageName = "Update", Stage = 20, PrimaryEntityName = "asx_rule",
                InitiatingUserId = Guid.NewGuid(), InputParameters = new ParameterCollection { { "Target", target } } };
            return (context, target, request);
        }

        [Fact]
        public void Publishing_is_refused_while_a_data_update_is_pending()
        {
            var (context, target, request) = FirstPublish();
            var e = Assert.Throws<InvalidPluginExecutionException>(() => context.ExecuteTransactional(request, new RulePublishPlugin(OneUpdate)));
            Assert.Equal(DataUpdateGate.PublishRefusal(1), e.Message);
            Assert.Null(target.GetAttributeValue<EntityReference>(PublicationSchema.Pointer));
        }

        [Fact]
        public void Publishing_proceeds_once_the_data_update_is_completed()
        {
            var (context, target, request) = FirstPublish();
            DataUpdateRows.Create(context.GetOrganizationService(), new DataUpdateRow(1, "Convert") { State = DataUpdateState.Completed });

            context.ExecuteTransactional(request, new RulePublishPlugin(OneUpdate));

            Assert.NotNull(target.GetAttributeValue<EntityReference>(PublicationSchema.Pointer));
            Assert.Equal(1, target.GetAttributeValue<int>(PublicationSchema.Number));
        }

        [Fact]
        public void A_publish_made_inside_asx_ApplyDataUpdates_is_not_gated()
        {
            // A data update republishes rules while it is itself still pending.
            var (context, target, request) = FirstPublish();
            request.ParentContext = new XrmFakedPluginExecutionContext { MessageName = "asx_" + SchemaNames.ApplyDataUpdatesApi.MessageName };

            context.ExecuteTransactional(request, new RulePublishPlugin(OneUpdate));

            Assert.NotNull(target.GetAttributeValue<EntityReference>(PublicationSchema.Pointer));
        }
    }
}
