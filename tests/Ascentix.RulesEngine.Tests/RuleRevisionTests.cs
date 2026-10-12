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
using FakeItEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Crm.Sdk.Messages;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public partial class RuleRevisionTests
    {
        private static readonly Guid Model = Guid.NewGuid();
        private static Entity RefRow(string entity, Guid id, string parentField, string parentEntity, Guid parent) =>
            new Entity(entity, id) { [parentField] = new EntityReference(parentEntity, parent) };

        internal static List<Entity> Rule(Guid id, string name = "Live")
        {
            var group = RefRow("asx_conditiongroup", Guid.NewGuid(), "asx_rule", "asx_rule", id);
            group["asx_name"] = "Outcome"; group["asx_logicaloperator"] = new OptionSetValue(1); group["asx_isexecutioncondition"] = false;
            var condition = RefRow("asx_rulecondition", Guid.NewGuid(), "asx_conditiongroup", group.LogicalName, group.Id);
            condition["asx_tableconfig"] = new EntityReference("asx_tableconfig", Model);
            condition["asx_conditiontype"] = new OptionSetValue(1); condition["asx_comparisoncolumn"] = "name";
            condition["asx_comparisonoperator"] = new OptionSetValue(1); condition["asx_comparisonvalue"] = "Valid";
            var action = RefRow("asx_ruleaction", Guid.NewGuid(), "asx_rule", "asx_rule", id);
            action["asx_actiontype"] = new OptionSetValue(4);
            action["asx_message"] = name; action["asx_order"] = 1; action["asx_isactive"] = true;
            var header = new Entity("asx_rule", id) { ["asx_name"] = name, ["asx_tablelogicalname"] = "account",
                ["statuscode"] = new OptionSetValue(753840000), ["asx_roottableconfig"] = new EntityReference("asx_tableconfig", Model),
                ["asx_triggers"] = new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue(2), new OptionSetValue(3), new OptionSetValue(4) }) };
            // Block when the rule's one outcome is false. The tree rows follow the first four.
            return new List<Entity> { header, group, condition, action, ActionTreeRows.AnyFalse(action.Id, group.Id) };
        }

        internal static TransactionalPluginContext Context(params List<Entity>[] rules)
        {
            var context = new TransactionalPluginContext();
            var rows = rules.SelectMany(r => r).ToList();
            rows.Add(new Entity("asx_tableconfig", Model) { ["asx_name"] = "Shared root", ["asx_tablelogicalname"] = "account", ["asx_tableconfigtype"] = new OptionSetValue(1) });
            rows.Add(new Entity(PublicationSchema.Lock, PublicationSchema.LockId));
            context.Initialize(rows);
            var metadata = new EntityMetadata { LogicalName = "account" };
            typeof(EntityMetadata).GetProperty("Attributes").SetValue(metadata, new AttributeMetadata[] { new StringAttributeMetadata { LogicalName = "name" } });
            var configMetadata = PublicationSchema.ConfigTables.Concat(new[] { PublicationSchema.Revision }).Select((table, index) => {
                var entity = new EntityMetadata { LogicalName = table };
                typeof(EntityMetadata).GetProperty("ObjectTypeCode").SetValue(entity, (int?)(10000 + index));
                return entity;
            });
            context.InitializeMetadata(new[] { metadata });
            var byName = configMetadata.Concat(new[] { metadata }).ToDictionary(entity => entity.LogicalName);
            context.AddExecutionMock<RetrieveEntityRequest>(request => new RetrieveEntityResponse {
                Results = new ParameterCollection { ["EntityMetadata"] = byName[((RetrieveEntityRequest)request).LogicalName] } });
            return context;
        }

        internal static Entity Freeze(IOrganizationService service, Guid rule, int version = 1)
        {
            var revision = PublicationCoordinator.Store(service, RuleSnapshot.Capture(service, rule), version, Guid.NewGuid());
            service.Update(new Entity("asx_rule", rule) { [PublicationSchema.Pointer] = revision.ToEntityReference(), [PublicationSchema.Number] = version });
            return revision;
        }
        private static RuleSnapshot Read(IOrganizationService service, Guid rule) =>
            PublishedRules.Read(service, service.Retrieve("asx_rule", rule, new ColumnSet(true)));
        private static RuleEvaluationOutcome Run(IOrganizationService service) => new RulesEngineRunner().Run(service, service, "account",
            new List<RootInput> { new RootInput { Overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Invalid" } } },
            RuleTrigger.OnDemand, RuleChannel.Standard, 1033, RootBuildMode.UseTarget, new XrmFakedTracingService());

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
                RuleTrigger.OnDemand, RuleChannel.Standard, 1033, RootBuildMode.UseTarget, new XrmFakedTracingService());
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
        public void Revision_and_pointer_access_is_left_to_platform_permissions()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id));
            foreach (var target in new[] { new Entity(PublicationSchema.Revision, Guid.NewGuid()), new Entity("asx_rule", id) { [PublicationSchema.Pointer] = new EntityReference(PublicationSchema.Revision, Guid.NewGuid()) } })
            {
                var request = new XrmFakedPluginExecutionContext { Stage = 20, MessageName = "Update", PrimaryEntityName = target.LogicalName,
                    InputParameters = new ParameterCollection { { "Target", target } } };
                context.ExecuteTransactional<RuleRevisionGuardPlugin>(request);
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
        public void Restore_requires_only_the_rule_id_after_the_API_privilege_gate()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService(); var revision = Freeze(service, id);
            var draftId = OpenDraft(context, id);
            var rights = AccessRights.ReadAccess;
            context.AddExecutionMock<RetrievePrincipalAccessRequest>(_ => new RetrievePrincipalAccessResponse {
                Results = new ParameterCollection { { "AccessRights", rights } } });
            var request = new XrmFakedPluginExecutionContext { Stage = 30, MessageName = "asx_RestoreRuleDraft", InitiatingUserId = Guid.NewGuid(),
                InputParameters = new ParameterCollection { { "RuleId", draftId.ToString() } } };
            context.ExecuteTransactional<RuleRevisionApi>(request);
            Assert.Equal(revision.Id, service.Retrieve("asx_rule", id, new ColumnSet(true)).GetAttributeValue<EntityReference>(PublicationSchema.Pointer).Id);
        }

        [Fact]
        public void Publication_validates_the_latest_saved_graph_without_a_stale_hash_veto()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService(); var revision = Freeze(service, id);
            var draftId = OpenDraft(context, id);
            var hash = RuleSnapshot.Capture(service, draftId).Hash();
            var model = service.Retrieve("asx_rule", draftId, new ColumnSet(true)).GetAttributeValue<EntityReference>("asx_roottableconfig");
            service.Update(new Entity("asx_tableconfig", model.Id) { ["asx_name"] = "Changed after validation" });
            var target = new Entity("asx_rule", draftId) { ["statuscode"] = new OptionSetValue(753840000), [PublicationSchema.PublishHash] = hash };
            var request = new XrmFakedPluginExecutionContext { MessageName = "Update", Stage = 20, PrimaryEntityName = "asx_rule",
                InputParameters = new ParameterCollection { { "Target", target } } };
            context.ExecuteTransactional<RulePublishPlugin>(request);
            Assert.NotEqual(revision.Id, service.Retrieve("asx_rule", id, new ColumnSet(true)).GetAttributeValue<EntityReference>(PublicationSchema.Pointer).Id);
            Assert.Equal("Changed after validation", Read(service, id).Rows.Single(row => row.Id == model.Id).ToSdk().GetAttributeValue<string>("asx_name"));
        }

        [Fact]
        public void Publication_validates_and_prepares_a_new_pointer_without_unpublishing()
        {
            var id = Guid.NewGuid(); var context = Context(Rule(id)); var service = context.GetOrganizationService(); var revision = Freeze(service, id);
            var draftId = OpenDraft(context, id);
            var target = new Entity("asx_rule", draftId) { ["statuscode"] = new OptionSetValue(753840000), [PublicationSchema.PublishHash] = RuleSnapshot.Capture(service, draftId).Hash() };
            var request = new XrmFakedPluginExecutionContext { MessageName = "Update", Stage = 20, PrimaryEntityName = "asx_rule", InitiatingUserId = Guid.NewGuid(),
                InputParameters = new ParameterCollection { { "Target", target } } };
            context.ExecuteTransactional<RulePublishPlugin>(request);
            var active = service.Retrieve("asx_rule", id, new ColumnSet(true));
            Assert.Equal(2, active.GetAttributeValue<int>(PublicationSchema.Number));
            Assert.NotEqual(revision.Id, active.GetAttributeValue<EntityReference>(PublicationSchema.Pointer).Id);
            Assert.Equal(1, target.GetAttributeValue<OptionSetValue>("statuscode").Value);
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

        // ─── Node GUIDs inside relative-date filters (asx_value / asx_expressionfilters / mapping filters) ──

        private static string AnchorOn(Guid node) =>
            "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + node + "\",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":30,\"unit\":\"days\"}";

        // One filter map: a FieldReference leaf (valueNodeId), a date-expression leaf whose anchor
        // node sits inside the JSON-string `value`, a literal leaf whose `value` is a GUID-shaped
        // string (must NOT be remapped), and an EXISTS (collectionNodeId).
        private static string FilterMap(Guid node) =>
            "{\"f1\":{\"kind\":\"group\",\"op\":\"and\",\"rules\":["
            + "{\"kind\":\"rule\",\"column\":\"name\",\"operator\":1,\"valueSource\":2,\"valueNodeId\":\"" + node + "\",\"valueColumn\":\"name\"},"
            + "{\"kind\":\"rule\",\"column\":\"createdon\",\"operator\":6,\"valueSource\":4,\"value\":\"" + AnchorOn(node).Replace("\"", "\\\"") + "\"},"
            + "{\"kind\":\"rule\",\"column\":\"name\",\"operator\":1,\"valueSource\":1,\"value\":\"" + node + "\"},"
            + "{\"kind\":\"exists\",\"collectionNodeId\":\"" + node + "\",\"minCount\":1,\"sub\":{\"kind\":\"group\",\"op\":\"and\",\"rules\":[]}}"
            + "]}}";

        private static void AssertFilterMapRemapped(Dictionary<string, NodeFilterGroup> filters, Guid model)
        {
            var rules = filters["f1"].Criteria;
            Assert.Equal(model, rules[0].ComparisonValueNodeId);
            Assert.True(DateExprSpec.TryGetAnchorNode(rules[1].Value, out var anchor));
            Assert.Equal(model, anchor);
            Assert.Equal(Model.ToString(), rules[2].Value);   // a literal value is never remapped
            Assert.Equal(model, rules[3].CollectionNodeId);
        }

        private static List<Entity> RuleWithDateFilters(Guid id)
        {
            var rows = Rule(id);
            var condition = rows[2];
            condition["asx_expressionfilters"] = FilterMap(Model);
            var filterGroup = RefRow("asx_nodefiltergroup", Guid.NewGuid(), "asx_conditiongroup", "asx_conditiongroup", rows[1].Id);
            filterGroup["asx_rulecondition"] = condition.ToEntityReference();
            filterGroup["asx_tableconfignode"] = new EntityReference("asx_tableconfig", Model);
            filterGroup["asx_logicaloperator"] = new OptionSetValue(1);
            var dated = RefRow("asx_nodefiltercriterion", Guid.NewGuid(), "asx_filtergroup", "asx_nodefiltergroup", filterGroup.Id);
            dated["asx_fieldname"] = "createdon"; dated["asx_operator"] = "le";
            dated["asx_comparisonvaluesource"] = new OptionSetValue(4); dated["asx_value"] = AnchorOn(Model);
            var literal = RefRow("asx_nodefiltercriterion", Guid.NewGuid(), "asx_filtergroup", "asx_nodefiltergroup", filterGroup.Id);
            literal["asx_fieldname"] = "name"; literal["asx_operator"] = "eq";
            literal["asx_comparisonvaluesource"] = new OptionSetValue(1); literal["asx_value"] = Model.ToString();
            rows[3]["asx_fieldmapping"] = "[{\"target\":\"description\",\"source\":\"mathexpr\",\"expression\":\"sum(node:" + Model + ".revenue filter:f1)\","
                + "\"filters\":" + FilterMap(Model) + "}]";
            rows.Add(filterGroup); rows.Add(dated); rows.Add(literal);
            return rows;
        }

        private static void AssertDateFiltersRemapped(IOrganizationService service, Guid ruleId)
        {
            var model = service.Retrieve("asx_rule", ruleId, new ColumnSet(true)).GetAttributeValue<EntityReference>("asx_roottableconfig").Id;
            Assert.NotEqual(Model, model);
            var snapshot = RuleSnapshot.Capture(service, ruleId).Rows.Select(r => r.ToSdk()).ToList();

            // (a) asx_nodefiltercriterion.asx_value when the source is DateExpression (4) only.
            var criteria = snapshot.Where(r => r.LogicalName == "asx_nodefiltercriterion").ToList();
            var dated = criteria.Single(r => r.GetAttributeValue<OptionSetValue>("asx_comparisonvaluesource").Value == 4);
            Assert.True(DateExprSpec.TryGetAnchorNode(dated.GetAttributeValue<string>("asx_value"), out var anchor));
            Assert.Equal(model, anchor);
            var literal = criteria.Single(r => r.GetAttributeValue<OptionSetValue>("asx_comparisonvaluesource").Value == 1);
            Assert.Equal(Model.ToString(), literal.GetAttributeValue<string>("asx_value"));

            // (b) asx_rulecondition.asx_expressionfilters.
            var condition = snapshot.Single(r => r.LogicalName == "asx_rulecondition");
            AssertFilterMapRemapped(Ascentix.RulesEngine.Core.Actions.AggregateFilterParser.ParseJson(
                condition.GetAttributeValue<string>("asx_expressionfilters"), "test"), model);

            // (c) date anchors inside field-mapping `filters` leaves (plus the existing node ids).
            var action = snapshot.Single(r => r.LogicalName == "asx_ruleaction");
            var entry = Ascentix.RulesEngine.Core.Actions.FieldMappingParser.Parse(action.GetAttributeValue<string>("asx_fieldmapping")).Single();
            AssertFilterMapRemapped(entry.Filters, model);
        }

        [Fact]
        public void Restore_remaps_node_ids_inside_date_expression_filters()
        {
            var id = Guid.NewGuid(); var context = Context(RuleWithDateFilters(id)); var service = context.GetOrganizationService(); Freeze(service, id);
            RuleRevisionApi.Restore(service, service.Retrieve("asx_rule", id, new ColumnSet(true)), Read(service, id));
            AssertDateFiltersRemapped(service, id);
        }

        [Fact]
        public void Opening_a_working_draft_remaps_node_ids_inside_date_expression_filters()
        {
            var id = Guid.NewGuid(); var context = Context(RuleWithDateFilters(id)); var service = context.GetOrganizationService(); Freeze(service, id);
            var draftId = OpenDraft(context, id);
            Assert.NotEqual(id, draftId);
            AssertDateFiltersRemapped(service, draftId);
        }
    }
}
