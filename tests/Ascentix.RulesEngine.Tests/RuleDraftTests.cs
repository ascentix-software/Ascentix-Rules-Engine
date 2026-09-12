using System;
using System.Linq;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Plugin.Publication;
using FakeXrmEasy;
using FakeItEasy;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public partial class RuleRevisionTests
    {
        private static Guid OpenDraft(TransactionalPluginContext context, Guid ruleId)
        {
            context.AddExecutionMock<RetrievePrincipalAccessRequest>(_ => new RetrievePrincipalAccessResponse {
                Results = new ParameterCollection { { "AccessRights", AccessRights.ReadAccess | AccessRights.WriteAccess } } });
            var request = new XrmFakedPluginExecutionContext { Stage = 30, MessageName = "asx_OpenRuleDraft", InitiatingUserId = Guid.NewGuid(),
                InputParameters = new ParameterCollection { { "RuleId", ruleId.ToString() } }, OutputParameters = new ParameterCollection() };
            context.ExecuteTransactional<RuleRevisionApi>(request);
            return Guid.Parse((string)request.OutputParameters["DraftId"]);
        }

        [Fact]
        public void Opening_an_existing_published_rule_creates_one_draft_without_converting_any_live_rules()
        {
            var id = Guid.NewGuid(); var context = Context(new[] { Rule(id) }.Concat(Enumerable.Range(0, 25).Select(_ => Rule(Guid.NewGuid()))).ToArray());
            var service = context.GetOrganizationService();
            var before = RuleSnapshot.Capture(service, id).Hash();
            var draftId = OpenDraft(context, id);
            Assert.NotEqual(id, draftId);
            Assert.Equal(draftId, OpenDraft(context, id));
            Assert.Equal(before, RuleSnapshot.Capture(service, id).Hash());
            Assert.Empty(service.RetrieveMultiple(new QueryExpression(PublicationSchema.Revision)).Entities);
            Assert.Equal(27, service.RetrieveMultiple(new QueryExpression("asx_rule")).Entities.Count);
            var draft = service.Retrieve("asx_rule", draftId, new ColumnSet(true));
            Assert.Equal(1, draft.GetAttributeValue<OptionSetValue>("statuscode").Value);
            Assert.Equal(id, draft.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf).Id);
            Assert.NotEqual(Model, draft.GetAttributeValue<EntityReference>("asx_roottableconfig").Id);
            Assert.All(RuleSnapshot.Capture(service, draftId).Rows.Where(row => row.Entity == "asx_tableconfig"), row => Assert.True(row.ToSdk().GetAttributeValue<bool>("asx_isprivate")));
        }

        [Fact]
        public void Saving_draft_and_publishing_preserves_the_original_rule_identity_and_live_status()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService();
            var draftId = OpenDraft(context, id);
            var action = new RuleActionLoader(service).LoadActionsByRule(new[] { draftId })[draftId].Single();
            var actionRow = RuleSnapshot.Capture(service, draftId).Rows.Single(row => row.Entity == "asx_ruleaction");
            var patch = new Entity("asx_ruleaction", actionRow.Id) { ["asx_message"] = "Changed draft" };
            context.ExecuteTransactional<RuleRevisionGuardPlugin>(new XrmFakedPluginExecutionContext { Stage = 20, MessageName = "Update",
                PrimaryEntityName = patch.LogicalName, InputParameters = new ParameterCollection { { "Target", patch } } });
            service.Update(patch);
            Assert.Equal("Live", new RuleActionLoader(service).LoadActionsByRule(new[] { id })[id].Single().Message);
            Assert.Null(service.Retrieve("asx_rule", id, new ColumnSet(true)).GetAttributeValue<EntityReference>(PublicationSchema.Pointer));
            var target = new Entity("asx_rule", draftId) { ["statuscode"] = new OptionSetValue(753840000),
                [PublicationSchema.PublishHash] = RuleSnapshot.Capture(service, draftId).Hash() };
            var request = new XrmFakedPluginExecutionContext { Stage = 20, MessageName = "Update", PrimaryEntityName = "asx_rule", InitiatingUserId = Guid.NewGuid(),
                InputParameters = new ParameterCollection { { "Target", target } } };
            context.ExecuteTransactional<RuleRevisionGuardPlugin>(request);
            context.ExecuteTransactional<RulePublishPlugin>(request);
            service.Update(target);
            var active = service.Retrieve("asx_rule", id, new ColumnSet(true));
            Assert.Equal(753840000, active.GetAttributeValue<OptionSetValue>("statuscode").Value);
            Assert.Equal(1, active.GetAttributeValue<int>(PublicationSchema.Number));
            Assert.Equal(1, target.GetAttributeValue<OptionSetValue>("statuscode").Value);
            var snapshot = PublishedRules.Read(service, active);
            Assert.Equal(id, snapshot.RuleId);
            Assert.Equal("Changed draft", snapshot.Rows.Single(row => row.Entity == "asx_ruleaction").ToSdk().GetAttributeValue<string>("asx_message"));
            Assert.All(snapshot.Rows.SelectMany(row => row.Attributes.Values).Where(value => value.Kind == "reference" && value.Entity == "asx_rule"),
                value => Assert.Equal(id.ToString(), value.Value));
        }

        [Fact]
        public void Direct_edits_to_published_configuration_are_rejected_without_initializing_other_rules()
        {
            var id = Guid.NewGuid(); var rows = Rule(id); var context = Context(rows); var service = context.GetOrganizationService();
            var patch = new Entity("asx_ruleaction", rows[3].Id) { ["asx_message"] = "Direct edit" };
            var error = Assert.Throws<InvalidPluginExecutionException>(() => context.ExecuteTransactional<RuleRevisionGuardPlugin>(
                new XrmFakedPluginExecutionContext { Stage = 20, MessageName = "Update", PrimaryEntityName = patch.LogicalName,
                    InputParameters = new ParameterCollection { { "Target", patch } } }));
            Assert.Contains("working draft", error.Message);
            Assert.Empty(service.RetrieveMultiple(new QueryExpression(PublicationSchema.Revision)).Entities);
        }

        [Fact]
        public void Shared_model_edit_preserves_affected_live_rules_without_changing_publication_versions()
        {
            var first = Guid.NewGuid(); var second = Guid.NewGuid(); var unrelated = Guid.NewGuid();
            var context = Context(Rule(first), Rule(second), Rule(unrelated)); var service = context.GetOrganizationService();
            var otherModel = new Entity("asx_tableconfig", Guid.NewGuid()) { ["asx_name"] = "Other", ["asx_tablelogicalname"] = "account", ["asx_tableconfigtype"] = new OptionSetValue(1) };
            service.Create(otherModel);
            service.Update(new Entity("asx_rule", unrelated) { ["asx_roottableconfig"] = otherModel.ToEntityReference() });
            foreach (var row in RuleSnapshot.Capture(service, unrelated).Rows.Where(row => row.Entity == "asx_rulecondition"))
                service.Update(new Entity(row.Entity, row.Id) { ["asx_tableconfig"] = otherModel.ToEntityReference() });
            // An unrelated missing node must not make the model edit load that broken rule.
            service.Delete("asx_tableconfig", otherModel.Id);
            var patch = new Entity("asx_tableconfig", Model) { ["asx_name"] = "Updated model" };
            context.ExecuteTransactional<RuleRevisionGuardPlugin>(new XrmFakedPluginExecutionContext { Stage = 20, MessageName = "Update",
                PrimaryEntityName = patch.LogicalName, InitiatingUserId = Guid.NewGuid(), InputParameters = new ParameterCollection { { "Target", patch } } });
            service.Update(patch);
            Assert.Equal(2, service.RetrieveMultiple(new QueryExpression(PublicationSchema.Revision)).Entities.Count);
            foreach (var id in new[] { first, second })
            {
                Assert.Equal("Shared root", Read(service, id).Rows.Single(row => row.Id == Model).ToSdk().GetAttributeValue<string>("asx_name"));
                Assert.Equal(0, service.Retrieve("asx_rule", id, new ColumnSet(true)).GetAttributeValue<int>(PublicationSchema.Number));
            }
            Assert.Null(service.Retrieve("asx_rule", unrelated, new ColumnSet(true)).GetAttributeValue<EntityReference>(PublicationSchema.Pointer));
        }

        [Fact]
        public void Restoring_repeatedly_reclaims_private_models_and_keeps_live_rows_unchanged()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService();
            var before = RuleSnapshot.Capture(service, id);
            var draftId = OpenDraft(context, id);
            var header = service.Retrieve("asx_rule", draftId, new ColumnSet(true));
            for (var i = 0; i < 3; i++)
                RuleRevisionApi.Restore(service, header, RuleDrafts.Reidentify(before, draftId));
            Assert.Equal(before.Hash(), RuleSnapshot.Capture(service, id).Hash());
            Assert.Equal(2, service.RetrieveMultiple(new QueryExpression("asx_tableconfig")).Entities.Count);
            Assert.Equal(id, service.Retrieve("asx_rule", draftId, new ColumnSet(true)).GetAttributeValue<EntityReference>(PublicationSchema.DraftOf).Id);
        }

        [Fact]
        public void Copying_a_published_rule_uses_its_snapshot_and_clones_the_model_without_a_draft_link()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService();
            Freeze(service, id);
            service.Update(new Entity("asx_tableconfig", Model) { ["asx_name"] = "Changed shared model" });
            var user = Guid.NewGuid();
            context.AddExecutionMock<RetrievePrincipalAccessRequest>(_ => new RetrievePrincipalAccessResponse {
                Results = new ParameterCollection { ["AccessRights"] = AccessRights.ReadAccess } });
            var request = new XrmFakedPluginExecutionContext { Stage = 30, MessageName = "asx_CopyRule", InitiatingUserId = user,
                InputParameters = new ParameterCollection { ["RuleId"] = id.ToString() }, OutputParameters = new ParameterCollection() };
            context.ExecuteTransactional<RuleRevisionApi>(request);
            var copyId = Guid.Parse((string)request.OutputParameters["NewRuleId"]);
            var copy = service.Retrieve("asx_rule", copyId, new ColumnSet(true));
            Assert.Equal("Copy of Live", copy.GetAttributeValue<string>("asx_name"));
            Assert.Equal(1, copy.GetAttributeValue<OptionSetValue>("statuscode").Value);
            Assert.Null(copy.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf));
            Assert.Null(copy.GetAttributeValue<EntityReference>(PublicationSchema.Pointer));
            Assert.Equal(user, copy.GetAttributeValue<EntityReference>("ownerid").Id);
            var model = service.Retrieve("asx_tableconfig", copy.GetAttributeValue<EntityReference>("asx_roottableconfig").Id, new ColumnSet(true));
            Assert.NotEqual(Model, model.Id);
            Assert.Equal("Shared root", model.GetAttributeValue<string>("asx_name"));
            Assert.All(RuleSnapshot.Capture(service, copyId).Rows.SelectMany(row => row.Attributes.Values)
                .Where(value => value.Kind == "reference" && value.Entity == "asx_rule"), value => Assert.Equal(copyId.ToString(), value.Value));
        }

        [Fact]
        public void Deleting_rule_removes_its_working_graph_and_retains_the_shared_model()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService();
            var draft = OpenDraft(context, id);
            context.ExecuteTransactional<RuleRevisionGuardPlugin>(new XrmFakedPluginExecutionContext {
                Stage = 20, MessageName = "Delete", PrimaryEntityName = "asx_rule",
                InputParameters = new ParameterCollection { { "Target", new EntityReference("asx_rule", id) } } });
            service.Delete("asx_rule", id);
            Assert.Empty(service.RetrieveMultiple(new QueryExpression("asx_rule")).Entities);
            Assert.Empty(service.RetrieveMultiple(new QueryExpression("asx_ruleaction")).Entities);
            Assert.Equal(Model, Assert.Single(service.RetrieveMultiple(new QueryExpression("asx_tableconfig")).Entities).Id);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void Internal_requests_exclude_only_matching_lifecycle_steps_from_our_signed_assembly(bool reconcile)
        {
            var context = new TransactionalPluginContext(); var service = context.GetOrganizationService();
            var assemblyName = typeof(PublicationCoordinator).Assembly.GetName();
            var assembly = new Entity("pluginassembly", Guid.NewGuid()) { ["name"] = assemblyName.Name,
                ["publickeytoken"] = string.Concat(assemblyName.GetPublicKeyToken().Select(b => b.ToString("x2"))) };
            var foreign = new Entity("pluginassembly", Guid.NewGuid()) { ["name"] = assemblyName.Name, ["publickeytoken"] = "other-signer" };
            var update = new Entity("sdkmessage", Guid.NewGuid()) { ["name"] = "Update" };
            var filter = new Entity("sdkmessagefilter", Guid.NewGuid()) { ["primaryobjecttypecode"] = 10000 };
            var metadata = new EntityMetadata { LogicalName = "asx_rule" };
            typeof(EntityMetadata).GetProperty("ObjectTypeCode").SetValue(metadata, (int?)10000);
            context.InitializeMetadata(new[] { metadata });
            context.Initialize(new[] { assembly, foreign, update, filter });
            Guid Step(string name, Entity owner, bool enabled = true) {
                var type = new Entity("plugintype", Guid.NewGuid()) { ["typename"] = name, ["pluginassemblyid"] = owner.ToEntityReference() };
                service.Create(type);
                var step = new Entity("sdkmessageprocessingstep", Guid.NewGuid()) { ["eventhandler"] = type.ToEntityReference(),
                    ["sdkmessageid"] = update.ToEntityReference(), ["sdkmessagefilterid"] = filter.ToEntityReference() };
                service.Create(step);
                service.Update(new Entity(step.LogicalName, step.Id) { ["statecode"] = new OptionSetValue(enabled ? 0 : 1) });
                return step.Id;
            }
            var guard = Step(typeof(RuleRevisionGuardPlugin).FullName, assembly);
            var publisher = Step(typeof(RulePublishPlugin).FullName, assembly);
            var registration = Step(typeof(RuleRegistrationPlugin).FullName, assembly);
            Step(typeof(RuleRevisionGuardPlugin).FullName, foreign);
            Step("Customer.OtherPlugin", assembly);
            Step(typeof(RuleRevisionGuardPlugin).FullName, assembly, enabled: false);
            context.AddExecutionMock<UpdateRequest>(request => {
                var ids = ((string)request["BypassBusinessLogicExecutionStepIds"]).Split(',').Select(Guid.Parse).ToArray();
                Assert.Equal((reconcile ? new[] { guard, publisher } : new[] { guard, publisher, registration }).OrderBy(id => id), ids.OrderBy(id => id));
                Assert.False(request.Parameters.Contains("BypassCustomPluginExecution"));
                Assert.False(request.Parameters.Contains("BypassBusinessLogicExecution"));
                return new UpdateResponse();
            });
            var execution = A.Fake<IPluginExecutionContext>();
            A.CallTo(() => execution.IsInTransaction).Returns(true);
            PublicationCoordinator.Internal(execution, service, writer => writer.Update(new Entity("asx_rule", Guid.NewGuid())), reconcile);
        }
    }
}
