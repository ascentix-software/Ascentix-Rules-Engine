using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Plugin.Publication;
using Ascentix.RulesEngine.Plugin.Registration;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Microsoft.Crm.Sdk.Messages;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleRevisionTests
    {
        private static readonly Guid Model = Guid.NewGuid();
        private static Entity RefRow(string entity, Guid id, string parentField, string parentEntity, Guid parent) =>
            new Entity(entity, id) { [parentField] = new EntityReference(parentEntity, parent) };

        private static List<Entity> Rule(Guid id, string name = "Live")
        {
            var group = RefRow("asx_conditiongroup", Guid.NewGuid(), "asx_rule", "asx_rule", id);
            group["asx_logicaloperator"] = new OptionSetValue(1); group["asx_isexecutioncondition"] = false;
            var condition = RefRow("asx_rulecondition", Guid.NewGuid(), "asx_conditiongroup", group.LogicalName, group.Id);
            condition["asx_tableconfig"] = new EntityReference("asx_tableconfig", Model);
            condition["asx_conditiontype"] = new OptionSetValue(1); condition["asx_comparisoncolumn"] = "name";
            condition["asx_comparisonoperator"] = new OptionSetValue(1); condition["asx_comparisonvalue"] = "Valid";
            var action = RefRow("asx_ruleaction", Guid.NewGuid(), "asx_rule", "asx_rule", id);
            action["asx_actiontype"] = new OptionSetValue(4); action["asx_fireon"] = new OptionSetValue(2);
            action["asx_message"] = name; action["asx_order"] = 1; action["asx_isactive"] = true;
            var header = new Entity("asx_rule", id) { ["asx_name"] = name, ["asx_tablelogicalname"] = "account",
                ["statuscode"] = new OptionSetValue(753840000), ["asx_roottableconfig"] = new EntityReference("asx_tableconfig", Model),
                ["asx_triggers"] = new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue(2), new OptionSetValue(3), new OptionSetValue(4) }) };
            return new List<Entity> { header, group, condition, action };
        }

        private static TransactionalPluginContext Context(params List<Entity>[] rules)
        {
            var context = new TransactionalPluginContext();
            var rows = rules.SelectMany(r => r).ToList();
            rows.Add(new Entity("asx_tableconfig", Model) { ["asx_name"] = "Shared root", ["asx_tablelogicalname"] = "account", ["asx_tableconfigtype"] = new OptionSetValue(1) });
            rows.Add(new Entity(PublicationSchema.Lock, PublicationSchema.LockId));
            context.Initialize(rows);
            var metadata = new EntityMetadata { LogicalName = "account" };
            typeof(EntityMetadata).GetProperty("Attributes").SetValue(metadata, new AttributeMetadata[] { new StringAttributeMetadata { LogicalName = "name" } });
            context.InitializeMetadata(new[] { metadata });
            return context;
        }

        private static Entity Freeze(IOrganizationService service, Guid rule, int version = 1)
        {
            var revision = PublicationCoordinator.Store(service, RuleSnapshot.Capture(service, rule), version, Guid.NewGuid());
            service.Update(new Entity("asx_rule", rule) { [PublicationSchema.Pointer] = revision.ToEntityReference(), [PublicationSchema.Number] = version });
            return revision;
        }
        private static RuleSnapshot Read(IOrganizationService service, Guid rule) =>
            PublishedRules.Read(service, service.Retrieve("asx_rule", rule, new ColumnSet(true)));
        private static RuleEvaluationOutcome Run(IOrganizationService service) => new RulesEngineRunner().Run(service, service, "account",
            new List<RootInput> { new RootInput { Overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Invalid" } } },
            RuleTrigger.Manual, RuleChannel.Standard, 1033, RootBuildMode.UseTarget, new XrmFakedTracingService());

        [Fact]
        public void Draft_changes_do_not_change_runtime_or_registration()
        {
            var id = Guid.NewGuid(); var rows = Rule(id); var context = Context(rows); var service = context.GetOrganizationService();
            Freeze(service, id);
            service.Update(new Entity("asx_rule", id) { ["asx_triggers"] = new OptionSetValueCollection(), ["asx_effectivefrom"] = DateTime.UtcNow.AddYears(1), ["asx_evaluationcontext"] = new OptionSetValue(2) });
            service.Update(new Entity("asx_ruleaction", rows[3].Id) { ["asx_isactive"] = false, ["asx_message"] = "Draft" });
            service.Update(new Entity("asx_rulecondition", rows[2].Id) { ["asx_comparisonvalue"] = "Invalid" });
            var result = Run(service);
            Assert.False(result.IsValid);
            Assert.Equal("Live", result.Records.Single().FiredActions.Single().Message);
            var analysis = new TableRuleAnalyzer(service).Analyze("account", null).Single();
            Assert.True(analysis.HasServerAction); Assert.True(analysis.OnUpdate);
        }

        [Fact]
        public void Forms_read_the_same_frozen_actions_and_conditions()
        {
            var id = Guid.NewGuid(); var rows = Rule(id); var context = Context(rows); var service = context.GetOrganizationService();
            Freeze(service, id);
            service.Update(new Entity("asx_ruleaction", rows[3].Id) { ["asx_message"] = "Draft only" });
            var request = new XrmFakedPluginExecutionContext { MessageName = "asx_ReadRules", Stage = 30,
                InputParameters = new ParameterCollection { { "TableName", "account" } }, OutputParameters = new ParameterCollection() };
            context.ExecutePluginWith<ReadRulesApi>(request);
            var json = (string)request.OutputParameters["Rules"];
            Assert.Contains("Live", json); Assert.DoesNotContain("Draft only", json); Assert.Contains("Valid", json);
        }

        [Fact]
        public void Shared_model_revisions_coexist_when_only_one_rule_is_republished()
        {
            var first = Guid.NewGuid(); var second = Guid.NewGuid(); var context = Context(Rule(first, "One"), Rule(second, "Two"));
            var service = context.GetOrganizationService(); Freeze(service, first); Freeze(service, second);
            service.Update(new Entity("asx_tableconfig", Model) { ["asx_name"] = "Changed shared model" });
            Freeze(service, first, 2);
            var a = new SnapshotService(service, Read(service, first)).Retrieve("asx_tableconfig", Model, new ColumnSet(true));
            var b = new SnapshotService(service, Read(service, second)).Retrieve("asx_tableconfig", Model, new ColumnSet(true));
            Assert.Equal("Changed shared model", a.GetAttributeValue<string>("asx_name"));
            Assert.Equal("Shared root", b.GetAttributeValue<string>("asx_name"));
            Assert.Equal(2, Run(service).Records.Single().FiredActions.Count);
        }

        [Fact]
        public void Different_published_link_fields_on_the_same_node_produce_independent_results()
        {
            var first = Guid.NewGuid(); var second = Guid.NewGuid(); var child = Guid.NewGuid();
            var a = Rule(first, "New link"); var b = Rule(second, "Old link");
            foreach (var rows in new[] { a, b }) {
                rows[2]["asx_tableconfig"] = new EntityReference("asx_tableconfig", child);
                rows[2]["asx_conditiontype"] = new OptionSetValue(2); rows[2]["asx_minexpectedrows"] = 1;
            }
            a.Add(new Entity("asx_tableconfig", child) { ["asx_tablelogicalname"] = "contact", ["asx_tableconfigtype"] = new OptionSetValue(3),
                ["asx_parenttable"] = new EntityReference("asx_tableconfig", Model), ["asx_childlinkfield"] = "parentcustomerid" });
            var account = Guid.NewGuid();
            a.Add(new Entity("contact", Guid.NewGuid()) { ["parentcustomerid"] = new EntityReference("account", account) });
            var context = Context(a, b); var service = context.GetOrganizationService(); Freeze(service, first); Freeze(service, second);
            service.Update(new Entity("asx_tableconfig", child) { ["asx_childlinkfield"] = "alternateparentid" });
            Freeze(service, first, 2);
            var outcome = new RulesEngineRunner().Run(service, service, "account",
                new List<RootInput> { new RootInput { Id = account, Overlay = new Entity("account", account) } },
                RuleTrigger.Manual, RuleChannel.Standard, 1033, RootBuildMode.UseTarget, new XrmFakedTracingService());
            var action = Assert.Single(outcome.Records.Single().FiredActions);
            Assert.Equal(first, action.RuleId);
        }

        [Fact]
        public void Snapshot_roundtrips_translations_nested_filters_and_exact_schedule()
        {
            var id = Guid.NewGuid(); var rows = Rule(id);
            var message = RefRow("asx_localizedmessage", Guid.NewGuid(), "asx_ruleaction", "asx_ruleaction", rows[3].Id);
            message["asx_languagecode"] = 1036; message["asx_message"] = "Français"; rows.Add(message);
            var filter = RefRow("asx_nodefiltergroup", Guid.NewGuid(), "asx_rulecondition", "asx_rulecondition", rows[2].Id);
            filter["asx_logicaloperator"] = new OptionSetValue(1); rows.Add(filter);
            var child = RefRow("asx_nodefiltergroup", Guid.NewGuid(), "asx_parentfiltergroup", "asx_nodefiltergroup", filter.Id);
            child["asx_logicaloperator"] = new OptionSetValue(2); rows.Add(child);
            var time = new DateTime(2026, 9, 30, 23, 59, 42, 125, DateTimeKind.Utc); rows[0]["asx_effectiveto"] = time;
            var context = Context(rows); var service = context.GetOrganizationService();
            var snapshot = RuleSnapshot.Capture(service, id); var parsed = RuleSnapshot.Parse(snapshot.Serialize(), id);
            Assert.Equal(snapshot.Hash(), parsed.Hash());
            var frozen = new SnapshotService(service, parsed);
            Assert.Equal("Français", new RuleActionLoader(frozen).LoadActionsByRule(new[] { id })[id].Single().LocalizedMessages[1036]);
            Assert.Equal(time, frozen.Retrieve("asx_rule", id, new ColumnSet(true)).GetAttributeValue<DateTime>("asx_effectiveto"));
            Assert.Contains(parsed.Rows, r => r.Id == child.Id);
        }

        [Fact]
        public void Corrupt_revision_never_falls_back_to_the_draft()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService(); var revision = Freeze(service, id);
            service.Update(new Entity(PublicationSchema.Revision, revision.Id) { ["asx_definition"] = "{}" });
            Assert.Throws<InvalidPluginExecutionException>(() => Run(service));
        }

        [Fact]
        public void Guard_rejects_direct_revision_and_pointer_mutations()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id));
            foreach (var target in new[] { new Entity(PublicationSchema.Revision, Guid.NewGuid()), new Entity("asx_rule", id) { [PublicationSchema.Pointer] = new EntityReference(PublicationSchema.Revision, Guid.NewGuid()) } })
            {
                var request = new XrmFakedPluginExecutionContext { Stage = 20, MessageName = "Update", PrimaryEntityName = target.LogicalName,
                    InputParameters = new ParameterCollection { { "Target", target } } };
                Assert.Throws<InvalidPluginExecutionException>(() => context.ExecuteTransactional<RuleRevisionGuardPlugin>(request));
            }
        }

        [Fact]
        public void Guard_rejects_creating_an_already_published_rule()
        {
            var context = Context();
            var target = Rule(Guid.NewGuid())[0];
            var request = new XrmFakedPluginExecutionContext { Stage = 20, MessageName = "Create", PrimaryEntityName = "asx_rule",
                InputParameters = new ParameterCollection { { "Target", target } } };
            var error = Assert.Throws<InvalidPluginExecutionException>(() => context.ExecuteTransactional<RuleRevisionGuardPlugin>(request));
            Assert.Contains("Create and save a draft", error.Message);
        }

        [Theory]
        [InlineData("Associate")]
        [InlineData("Disassociate")]
        public void Relationship_messages_cannot_bypass_publication_guards(string message)
        {
            var context = Context();
            var request = new XrmFakedPluginExecutionContext { Stage = 20, MessageName = message, PrimaryEntityName = "",
                InputParameters = new ParameterCollection {
                    { "Target", new EntityReference("asx_rule", Guid.NewGuid()) },
                    { "RelatedEntities", new EntityReferenceCollection { new EntityReference(PublicationSchema.Revision, Guid.NewGuid()) } } } };
            Assert.Contains("Use record Update", Assert.Throws<InvalidPluginExecutionException>(() => context.ExecuteTransactional<RuleRevisionGuardPlugin>(request)).Message);
            request.InputParameters["Target"] = new EntityReference("account", Guid.NewGuid());
            request.InputParameters["RelatedEntities"] = new EntityReferenceCollection { new EntityReference("contact", Guid.NewGuid()) };
            context.ExecuteTransactional<RuleRevisionGuardPlugin>(request);
        }

        [Fact]
        public void First_child_edit_captures_legacy_behavior_and_advances_draft_stamp()
        {
            var id = Guid.NewGuid(); var rows = Rule(id); var context = Context(rows); var service = context.GetOrganizationService();
            var target = new Entity("asx_ruleaction", rows[3].Id) { ["asx_message"] = "New draft" };
            var request = new XrmFakedPluginExecutionContext { Stage = 20, MessageName = "Update", PrimaryEntityName = target.LogicalName,
                InitiatingUserId = Guid.NewGuid(), InputParameters = new ParameterCollection { { "Target", target } } };
            context.ExecuteTransactional<RuleRevisionGuardPlugin>(request);
            service.Update(target);
            Assert.Equal("Live", Read(service, id).Rows.Single(r => r.Id == rows[3].Id).ToSdk().GetAttributeValue<string>("asx_message"));
            Assert.False(string.IsNullOrEmpty(service.Retrieve("asx_rule", id, new ColumnSet(true)).GetAttributeValue<string>(PublicationSchema.DraftStamp)));
        }

        [Fact]
        public void Backfill_is_bounded_and_restartable_without_duplicate_revisions()
        {
            var context = Context(Enumerable.Range(0, 12).Select(_ => Rule(Guid.NewGuid())).ToArray());
            var request = new XrmFakedPluginExecutionContext { Stage = 30, MessageName = "asx_InitializeRuleRevisions",
                InitiatingUserId = Guid.NewGuid(), InputParameters = new ParameterCollection(), OutputParameters = new ParameterCollection() };
            context.ExecuteTransactional<RuleRevisionApi>(request);
            Assert.Equal(2, request.OutputParameters["Remaining"]);
            context.ExecuteTransactional<RuleRevisionApi>(request);
            Assert.Equal(0, request.OutputParameters["Remaining"]);
            context.ExecuteTransactional<RuleRevisionApi>(request);
            Assert.Equal(12, context.GetOrganizationService().RetrieveMultiple(new QueryExpression(PublicationSchema.Revision)).Entities.Count);
        }

        [Fact]
        public void A_new_install_initializes_its_coordination_record()
        {
            var context = Context();
            context.GetOrganizationService().Delete(PublicationSchema.Lock, PublicationSchema.LockId);
            var request = new XrmFakedPluginExecutionContext { Stage = 30, MessageName = "asx_InitializeRuleRevisions",
                InitiatingUserId = Guid.NewGuid(), InputParameters = new ParameterCollection(), OutputParameters = new ParameterCollection() };
            context.ExecuteTransactional<RuleRevisionApi>(request);
            Assert.Equal(0, request.OutputParameters["Remaining"]);
            Assert.NotNull(context.GetOrganizationService().Retrieve(PublicationSchema.Lock, PublicationSchema.LockId, new ColumnSet(true)));
        }

        [Fact]
        public void Internal_restore_and_delete_writes_do_not_reconcile_intermediate_draft_state()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var correlation = Guid.NewGuid();
            context.GetOrganizationService().Update(new Entity("asx_rule", id) {
                [PublicationSchema.Pointer] = new EntityReference(PublicationSchema.Revision, Guid.NewGuid()) });
            var parent = new XrmFakedPluginExecutionContext { Stage = 20, CorrelationId = correlation, IsInTransaction = true,
                SharedVariables = new ParameterCollection { { "Ascentix.InternalRevisionWrite", correlation } } };
            var request = new XrmFakedPluginExecutionContext { Stage = 20, MessageName = "Update", PrimaryEntityName = "asx_rule",
                CorrelationId = correlation, ParentContext = parent,
                InputParameters = new ParameterCollection { { "Target", new Entity("asx_rule", id) { ["asx_tablelogicalname"] = "account" } } } };
            context.ExecuteTransactional<RuleRegistrationPlugin>(request);
        }

        [Fact]
        public void Tagged_internal_writes_require_registered_ancestry_and_exact_target_identity()
        {
            var context = Context(); var service = context.GetOrganizationService();
            var handler = new Entity("plugintype", Guid.NewGuid()) { ["typename"] = typeof(RuleRevisionApi).FullName };
            service.Create(handler);
            var api = new Entity("customapi", Guid.NewGuid()) { ["plugintypeid"] = handler.ToEntityReference() }; service.Create(api);
            var parent = new RemoteExecutionContext { Stage = 30, IsInTransaction = true,
                CorrelationId = Guid.NewGuid(), InitiatingUserId = Guid.NewGuid(), MessageName = "asx_RestoreRuleDraft",
                OwningExtension = api.ToEntityReference() };
            var target = new Entity("asx_ruleaction", Guid.NewGuid());
            var request = new RemoteExecutionContext { Stage = 20, IsInTransaction = true,
                CorrelationId = parent.CorrelationId, InitiatingUserId = parent.InitiatingUserId, MessageName = "Create", ParentContext = parent,
                SharedVariables = { { "tag", PublicationCoordinator.WriteTag(parent, "Create", target.ToEntityReference()) } },
                InputParameters = { { "Target", target } } };
            Assert.True(PublicationCoordinator.IsInternal(request, service));
            request.InputParameters["Target"] = new Entity("asx_ruleaction", Guid.NewGuid());
            Assert.False(PublicationCoordinator.IsInternal(request, service));
            request.InputParameters["Target"] = target;
            service.Update(new Entity("plugintype", handler.Id) { ["typename"] = "Unrelated.Plugin" });
            Assert.False(PublicationCoordinator.IsInternal(request, service));
            request.ParentContext = null;
            Assert.False(PublicationCoordinator.IsInternal(request, service));
        }

        [Fact]
        public void Restore_requires_write_access_and_a_current_draft_version()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService(); var revision = Freeze(service, id);
            var rights = AccessRights.ReadAccess;
            context.AddExecutionMock<RetrievePrincipalAccessRequest>(_ => new RetrievePrincipalAccessResponse {
                Results = new ParameterCollection { { "AccessRights", rights } } });
            var request = new XrmFakedPluginExecutionContext { Stage = 30, MessageName = "asx_RestoreRuleDraft", InitiatingUserId = Guid.NewGuid(),
                InputParameters = new ParameterCollection { { "RuleId", id.ToString() }, { "ExpectedVersion", "stale" } } };
            Assert.Contains("permission to edit", Assert.Throws<InvalidPluginExecutionException>(() => context.ExecuteTransactional<RuleRevisionApi>(request)).Message);
            rights |= AccessRights.WriteAccess;
            Assert.Contains("changed elsewhere", Assert.Throws<InvalidPluginExecutionException>(() => context.ExecuteTransactional<RuleRevisionApi>(request)).Message);
            Assert.Equal(revision.Id, service.Retrieve("asx_rule", id, new ColumnSet(true)).GetAttributeValue<EntityReference>(PublicationSchema.Pointer).Id);
        }

        [Fact]
        public void Stale_shared_model_hash_rejects_publish_and_keeps_previous_pointer()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService(); var revision = Freeze(service, id);
            var hash = RuleSnapshot.Capture(service, id).Hash();
            service.Update(new Entity("asx_tableconfig", Model) { ["asx_name"] = "Changed after validation" });
            var target = new Entity("asx_rule", id) { ["statuscode"] = new OptionSetValue(753840000), [PublicationSchema.PublishHash] = hash };
            var request = new XrmFakedPluginExecutionContext { MessageName = "Update", Stage = 20, PrimaryEntityName = "asx_rule",
                InputParameters = new ParameterCollection { { "Target", target } } };
            var error = Assert.Throws<InvalidPluginExecutionException>(() => context.ExecuteTransactional<RulePublishPlugin>(request));
            Assert.Contains("changed after validation", error.Message);
            Assert.Equal(revision.Id, service.Retrieve("asx_rule", id, new ColumnSet(true)).GetAttributeValue<EntityReference>(PublicationSchema.Pointer).Id);
        }

        [Fact]
        public void Publication_validates_and_prepares_a_new_pointer_without_unpublishing()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService(); var revision = Freeze(service, id);
            var target = new Entity("asx_rule", id) { ["statuscode"] = new OptionSetValue(753840000), [PublicationSchema.PublishHash] = RuleSnapshot.Capture(service, id).Hash() };
            var request = new XrmFakedPluginExecutionContext { MessageName = "Update", Stage = 20, PrimaryEntityName = "asx_rule", InitiatingUserId = Guid.NewGuid(),
                InputParameters = new ParameterCollection { { "Target", target } } };
            context.ExecuteTransactional<RulePublishPlugin>(request);
            Assert.Equal(2, target.GetAttributeValue<int>(PublicationSchema.Number));
            Assert.NotEqual(revision.Id, target.GetAttributeValue<EntityReference>(PublicationSchema.Pointer).Id);
            Assert.Equal(753840000, service.Retrieve("asx_rule", id, new ColumnSet(true)).GetAttributeValue<OptionSetValue>("statuscode").Value);
        }

        [Fact]
        public void Restore_replaces_only_the_draft_and_clones_its_shared_model()
        {
            var id = Guid.NewGuid(); var rows = Rule(id); var context = Context(rows); var service = context.GetOrganizationService(); var revision = Freeze(service, id);
            var snapshot = Read(service, id);
            service.Update(new Entity("asx_ruleaction", rows[3].Id) { ["asx_message"] = "Draft edit" });
            service.Update(new Entity("asx_tableconfig", Model) { ["asx_name"] = "Other users model" });
            RuleRevisionApi.Restore(service, service.Retrieve("asx_rule", id, new ColumnSet(true)), snapshot);
            var header = service.Retrieve("asx_rule", id, new ColumnSet(true));
            Assert.Equal(revision.Id, header.GetAttributeValue<EntityReference>(PublicationSchema.Pointer).Id);
            Assert.NotEqual(Model, header.GetAttributeValue<EntityReference>("asx_roottableconfig").Id);
            Assert.Equal("Other users model", service.Retrieve("asx_tableconfig", Model, new ColumnSet(true)).GetAttributeValue<string>("asx_name"));
            Assert.Equal("Live", new RuleActionLoader(service).LoadActionsByRule(new[] { id })[id].Single().Message);
        }

        [Fact]
        public void Restore_remaps_references_but_preserves_literal_guids_and_escaped_tokens()
        {
            var id = Guid.NewGuid(); var rows = Rule(id);
            rows[3]["asx_message"] = $"Literal {Model} escaped {{{{node:{Model}.name}}}} field {{node:{Model}.name}}";
            rows[3]["asx_fieldmapping"] = $"[{{\"target\":\"name\",\"source\":\"literal\",\"value\":\"{Model}\"}},{{\"target\":\"description\",\"source\":\"node\",\"node\":\"{Model}\",\"column\":\"name\"}}]";
            rows[2]["asx_comparisonvalue"] = Model.ToString();
            var context = Context(rows); var service = context.GetOrganizationService(); Freeze(service, id);
            RuleRevisionApi.Restore(service, service.Retrieve("asx_rule", id, new ColumnSet(true)), Read(service, id));
            var model = service.Retrieve("asx_rule", id, new ColumnSet(true)).GetAttributeValue<EntityReference>("asx_roottableconfig").Id;
            var action = new RuleActionLoader(service).LoadActionsByRule(new[] { id })[id].Single();
            Assert.Equal($"Literal {Model} escaped {{{{node:{Model}.name}}}} field {{node:{model}.name}}", action.Message);
            var mapping = Ascentix.RulesEngine.Core.Actions.FieldMappingParser.Parse(action.FieldMapping);
            Assert.Equal(Model.ToString(), mapping[0].Value);
            Assert.Equal(model, mapping[1].Node);
            var condition = RuleSnapshot.Capture(service, id).Rows.Single(r => r.Entity == "asx_rulecondition").ToSdk();
            Assert.Equal(Model.ToString(), condition.GetAttributeValue<string>("asx_comparisonvalue"));
        }
    }
}
