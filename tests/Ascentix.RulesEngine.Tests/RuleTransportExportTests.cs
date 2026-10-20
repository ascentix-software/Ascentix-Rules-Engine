using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleTransportExportTests
    {
        internal static TransactionalPluginContext Prepare(List<Entity> rule, params Entity[] extra)
        {
            var context = RuleRevisionTests.Context(rule);
            var service = context.GetOrganizationService();
            foreach (var row in extra) service.Create(row);
            if (!extra.Any(e => e.LogicalName == "solution"))
                service.Create(new Entity("solution", Guid.NewGuid()) { ["uniquename"] = "AscentixRulesEngine", ["version"] = "0.1.0.2" });
            // primarycontactid on account is a lookup to contact; every other column is not a lookup.
            context.AddExecutionMock<RetrieveAttributeRequest>(request =>
            {
                var attribute = (RetrieveAttributeRequest)request;
                AttributeMetadata metadata = attribute.LogicalName == "primarycontactid"
                    ? new LookupAttributeMetadata { LogicalName = attribute.LogicalName, Targets = new[] { "contact" } }
                    : new StringAttributeMetadata { LogicalName = attribute.LogicalName };
                return new RetrieveAttributeResponse { Results = new ParameterCollection { ["AttributeMetadata"] = metadata } };
            });
            return context;
        }

        internal static TransportEntry Export(TransactionalPluginContext context, Guid ruleId)
        {
            var request = new XrmFakedPluginExecutionContext { Stage = 30, MessageName = "asx_ExportRule", InitiatingUserId = Guid.NewGuid(),
                InputParameters = new ParameterCollection { { "RuleId", ruleId.ToString() } }, OutputParameters = new ParameterCollection() };
            context.ExecuteTransactional<RuleTransportApi>(request);
            return TransportEntry.Parse((string)request.OutputParameters["Entry"]);
        }

        [Fact]
        public void Export_returns_the_published_revision_not_the_live_rows()
        {
            var id = Guid.NewGuid(); var rows = RuleRevisionTests.Rule(id);
            var context = Prepare(rows); var service = context.GetOrganizationService();
            var revision = RuleRevisionTests.Freeze(service, id, 3);
            service.Update(new Entity("asx_ruleaction", rows[3].Id) { ["asx_message"] = "Edited after publishing" });

            var entry = Export(context, id);

            Assert.Equal(revision.GetAttributeValue<string>("asx_hash"), entry.Definition.Hash());
            Assert.Equal(revision.GetAttributeValue<string>("asx_hash"), entry.Hash);
            Assert.Equal(3, entry.Version);
            Assert.Equal("Live", entry.Definition.Rows.Single(r => r.Entity == "asx_ruleaction").ToSdk().GetAttributeValue<string>("asx_message"));
        }

        [Fact]
        public void Export_includes_rule_set_name_version_and_schedule_definition_only()
        {
            var id = Guid.NewGuid(); var rows = RuleRevisionTests.Rule(id);
            var set = new Entity("asx_ruleset", Guid.NewGuid()) { ["asx_name"] = "Billing" };
            rows[0]["asx_ruleset"] = set.ToEntityReference();
            var schedule = new Entity("asx_ruleschedule", Guid.NewGuid()) {
                ["asx_name"] = "Weekly", ["asx_rule"] = new EntityReference("asx_rule", id), ["asx_on"] = true,
                ["asx_pattern"] = new OptionSetValue(4), ["asx_timeofday"] = "06:30",
                ["asx_daysofweek"] = new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue(5), new OptionSetValue(1) }),
                ["asx_nextrunon"] = new DateTime(2026, 10, 20, 6, 30, 0), ["asx_lastrunon"] = new DateTime(2026, 10, 13, 6, 30, 0),
                ["asx_lastrun"] = new EntityReference("asx_rulerun", Guid.NewGuid()) };
            var context = Prepare(rows, set, schedule); var service = context.GetOrganizationService();
            RuleRevisionTests.Freeze(service, id, 2);

            var entry = Export(context, id);

            Assert.Equal("Billing", entry.RuleSet);
            Assert.Equal("Live", entry.Name);
            Assert.Equal(id, entry.Id);
            Assert.Equal(2, entry.Version);
            Assert.Equal("0.1.0.2", entry.EngineVersion);
            Assert.True(entry.Schedule.On);
            Assert.Equal(4, entry.Schedule.Pattern);
            Assert.Equal("06:30", entry.Schedule.TimeOfDay);
            Assert.Equal("1,5", entry.Schedule.DaysOfWeek);
            Assert.Null(entry.Schedule.Every);
            var json = entry.Serialize();
            Assert.DoesNotContain("nextrunon", json, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("lastrun", json, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void Export_has_no_schedule_or_rule_set_when_the_rule_has_none()
        {
            var id = Guid.NewGuid();
            var context = Prepare(RuleRevisionTests.Rule(id)); RuleRevisionTests.Freeze(context.GetOrganizationService(), id);
            var entry = Export(context, id);
            Assert.Null(entry.Schedule);
            Assert.Null(entry.RuleSet);
        }

        [Theory]
        [InlineData(1)]
        [InlineData(2)]
        public void Export_refuses_draft_and_archived_rules(int status)
        {
            var id = Guid.NewGuid(); var rows = RuleRevisionTests.Rule(id);
            rows[0]["statuscode"] = new OptionSetValue(status);
            var context = Prepare(rows);
            var error = Assert.Throws<InvalidPluginExecutionException>(() => Export(context, id));
            Assert.Contains("only published rules can be exported", error.Message);
        }

        [Fact]
        public void Export_refuses_a_working_draft_row()
        {
            var id = Guid.NewGuid(); var rows = RuleRevisionTests.Rule(id);
            rows[0][PublicationSchema.DraftOf] = new EntityReference("asx_rule", Guid.NewGuid());
            var context = Prepare(rows);
            var error = Assert.Throws<InvalidPluginExecutionException>(() => Export(context, id));
            Assert.Contains("only published rules can be exported", error.Message);
        }

        [Fact]
        public void Record_literal_on_a_lookup_comparison_is_listed_with_its_target_tables()
        {
            var id = Guid.NewGuid(); var rows = RuleRevisionTests.Rule(id);
            var contact = Guid.NewGuid();
            rows[2]["asx_comparisoncolumn"] = "primarycontactid";
            rows[2]["asx_comparisonvalue"] = contact.ToString();
            var context = Prepare(rows); RuleRevisionTests.Freeze(context.GetOrganizationService(), id);

            var entry = Export(context, id);

            var reference = Assert.Single(entry.RecordReferences);
            Assert.Equal("asx_rulecondition", reference.RowEntity);
            Assert.Equal(rows[2].Id, reference.RowId);
            Assert.Equal("asx_comparisonvalue", reference.Attribute);
            Assert.Equal(contact, reference.RecordId);
            Assert.Equal(new[] { "contact" }, reference.Tables);
        }

        [Fact]
        public void Model_node_guids_in_templates_are_not_listed_as_records()
        {
            var id = Guid.NewGuid(); var rows = RuleRevisionTests.Rule(id);
            var node = Guid.NewGuid();
            var model = new Entity("asx_tableconfig", node) { ["asx_name"] = "Parent", ["asx_tablelogicalname"] = "contact", ["asx_tableconfigtype"] = new OptionSetValue(1) };
            rows[2]["asx_tableconfig"] = new EntityReference("asx_tableconfig", node);
            rows[2]["asx_comparisonvaluesource"] = new OptionSetValue(3);
            rows[2]["asx_comparisonvalue"] = "{node:" + node + ".fullname}";
            rows[3]["asx_fieldmapping"] = "[{\"target\":\"subject\",\"source\":\"template\",\"template\":\"Hi {node:" + node + ".fullname}\"},"
                + "{\"target\":\"ownerid\",\"source\":\"node\",\"node\":\"" + node + "\",\"column\":\"owner\"}]";
            var context = Prepare(rows, model); RuleRevisionTests.Freeze(context.GetOrganizationService(), id);

            var entry = Export(context, id);

            Assert.Empty(entry.RecordReferences);
        }

        [Fact]
        public void Field_mapping_lookup_literal_is_listed_with_its_table()
        {
            var id = Guid.NewGuid(); var rows = RuleRevisionTests.Rule(id);
            var owner = Guid.NewGuid();
            rows[3]["asx_fieldmapping"] = "[{\"target\":\"ownerid\",\"source\":\"literal\",\"value\":{\"id\":\"" + owner + "\",\"logicalname\":\"systemuser\"}},"
                + "{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Follow up\"}]";
            var context = Prepare(rows); RuleRevisionTests.Freeze(context.GetOrganizationService(), id);

            var reference = Assert.Single(Export(context, id).RecordReferences);

            Assert.Equal("asx_ruleaction", reference.RowEntity);
            Assert.Equal("asx_fieldmapping", reference.Attribute);
            Assert.Equal(owner, reference.RecordId);
            Assert.Equal(new[] { "systemuser" }, reference.Tables);
        }

        [Fact]
        public void Criterion_values_are_listed_on_the_table_their_group_targets_and_unknown_tables_stay_empty()
        {
            var id = Guid.NewGuid(); var rows = RuleRevisionTests.Rule(id);
            var contact = Guid.NewGuid(); var other = Guid.NewGuid(); var node = Guid.NewGuid();
            var model = new Entity("asx_tableconfig", node) { ["asx_name"] = "Account", ["asx_tablelogicalname"] = "account", ["asx_tableconfigtype"] = new OptionSetValue(1) };
            var searchGroup = new Entity("asx_searchcriteriagroup", Guid.NewGuid()) { ["asx_rulecondition"] = new EntityReference("asx_rulecondition", rows[2].Id), ["asx_logicaloperator"] = new OptionSetValue(1) };
            var search = new Entity("asx_searchcriterion", Guid.NewGuid()) {
                ["asx_criteriagroup"] = searchGroup.ToEntityReference(), ["asx_fieldname"] = "primarycontactid", ["asx_operator"] = "eq", ["asx_value"] = contact.ToString() };
            var filterGroup = new Entity("asx_nodefiltergroup", Guid.NewGuid()) { ["asx_conditiongroup"] = new EntityReference("asx_conditiongroup", rows[1].Id), ["asx_logicaloperator"] = new OptionSetValue(1) };
            var filter = new Entity("asx_nodefiltercriterion", Guid.NewGuid()) {
                ["asx_filtergroup"] = filterGroup.ToEntityReference(), ["asx_fieldname"] = "primarycontactid", ["asx_operator"] = "eq", ["asx_value"] = other.ToString() };
            var context = Prepare(rows, model, searchGroup, search, filterGroup, filter); RuleRevisionTests.Freeze(context.GetOrganizationService(), id);

            var references = Export(context, id).RecordReferences;

            Assert.Equal(new[] { "contact" }, references.Single(r => r.RecordId == contact).Tables);
            Assert.Equal("asx_searchcriterion", references.Single(r => r.RecordId == contact).RowEntity);
            Assert.Empty(references.Single(r => r.RecordId == other).Tables);
        }

        [Fact]
        public void Export_fails_clearly_when_the_solution_version_is_not_found()
        {
            var id = Guid.NewGuid();
            var context = Prepare(RuleRevisionTests.Rule(id), new Entity("solution", Guid.NewGuid()) { ["uniquename"] = "Other", ["version"] = "9.9" });
            RuleRevisionTests.Freeze(context.GetOrganizationService(), id);
            var error = Assert.Throws<InvalidPluginExecutionException>(() => Export(context, id));
            Assert.Contains("solution version", error.Message);
        }

        [Fact]
        public void Literal_record_ids_in_calculation_filters_and_mathexpr_filters_are_listed_but_node_ids_are_not()
        {
            var id = Guid.NewGuid(); var rows = RuleRevisionTests.Rule(id);
            var inCondition = Guid.NewGuid(); var inMapping = Guid.NewGuid(); var node = Guid.NewGuid();
            var model = new Entity("asx_tableconfig", node) { ["asx_name"] = "Child", ["asx_tablelogicalname"] = "contact", ["asx_tableconfigtype"] = new OptionSetValue(1) };
            string Tree(Guid literal) => "{\"k\":{\"kind\":\"group\",\"op\":\"and\",\"rules\":["
                + "{\"kind\":\"rule\",\"column\":\"ownerid\",\"operator\":1,\"valueSource\":1,\"value\":\"" + literal + "\"},"
                + "{\"kind\":\"rule\",\"column\":\"parentid\",\"operator\":1,\"valueSource\":2,\"valueNodeId\":\"" + node + "\",\"valueColumn\":\"x\"},"
                + "{\"kind\":\"exists\",\"collectionNodeId\":\"" + node + "\",\"minCount\":1}]}}";
            rows[2]["asx_expressionfilters"] = Tree(inCondition);
            rows[3]["asx_fieldmapping"] = "[{\"target\":\"total\",\"source\":\"mathexpr\",\"expression\":\"sum(x)\",\"filters\":" + Tree(inMapping) + "}]";
            var context = Prepare(rows, model); RuleRevisionTests.Freeze(context.GetOrganizationService(), id);

            var references = Export(context, id).RecordReferences;

            Assert.Equal(2, references.Count);
            Assert.Equal("asx_expressionfilters", references.Single(r => r.RecordId == inCondition).Attribute);
            Assert.Equal("asx_fieldmapping", references.Single(r => r.RecordId == inMapping).Attribute);
            Assert.DoesNotContain(references, r => r.RecordId == node);
        }

        [Fact]
        public void Each_literal_of_an_array_valued_filter_leaf_is_listed()
        {
            var id = Guid.NewGuid(); var rows = RuleRevisionTests.Rule(id);
            var first = Guid.NewGuid(); var second = Guid.NewGuid();
            rows[2]["asx_expressionfilters"] = "{\"k\":{\"kind\":\"group\",\"op\":\"and\",\"rules\":["
                + "{\"kind\":\"rule\",\"column\":\"ownerid\",\"operator\":8,\"valueSource\":1,\"value\":[\"" + first + "\",\"" + second + "\"]}]}}";
            var context = Prepare(rows); RuleRevisionTests.Freeze(context.GetOrganizationService(), id);

            var references = Export(context, id).RecordReferences;

            Assert.Equal(new[] { first, second }.OrderBy(g => g), references.Select(r => r.RecordId).OrderBy(g => g));
            Assert.All(references, r => Assert.Equal("asx_expressionfilters", r.Attribute));
        }

        [Fact]
        public void Entry_round_trips_through_serialize_and_parse()
        {
            var id = Guid.NewGuid();
            var context = Prepare(RuleRevisionTests.Rule(id)); RuleRevisionTests.Freeze(context.GetOrganizationService(), id, 4);
            var entry = Export(context, id);

            var again = TransportEntry.Parse(entry.Serialize());

            Assert.Equal(entry.Serialize(), again.Serialize());
            Assert.Equal(entry.Hash, again.Definition.Hash());
            Assert.Equal(1, again.Format);
        }

        [Theory]
        [InlineData("")]
        [InlineData("not json")]
        [InlineData("{\"Format\":2}")]
        public void Parse_rejects_unreadable_entries(string json)
        {
            var error = Assert.Throws<InvalidPluginExecutionException>(() => TransportEntry.Parse(json));
            Assert.Equal("The rule package entry cannot be read.", error.Message);
        }
    }
}
