using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization.Json;
using System.Text;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Plugin.Publication;
using FakeXrmEasy;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleTransportImportTests
    {
        private const int Published = 753840000;
        private static readonly Guid Caller = Guid.NewGuid();

        // The target environment: no rules, the shared root model, the installed solution version and
        // metadata for account (name, primarycontactid -> contact) and contact.
        private static TransactionalPluginContext Target(params Entity[] extra)
        {
            var context = RuleRevisionTests.Context();
            var service = context.GetOrganizationService();
            service.Create(new Entity("solution", Guid.NewGuid()) { ["uniquename"] = "AscentixRulesEngine", ["version"] = "0.1.0.2" });
            foreach (var row in extra) service.Create(row);
            var tables = PublicationSchema.ConfigTables.Concat(new[] { PublicationSchema.Revision }).Select((table, index) => Metadata(table, 10000 + index)).ToList();
            var account = Metadata("account", 1);
            typeof(EntityMetadata).GetProperty("Attributes").SetValue(account, new AttributeMetadata[] {
                new StringAttributeMetadata { LogicalName = "name" },
                new LookupAttributeMetadata { LogicalName = "primarycontactid", Targets = new[] { "contact" } } });
            tables.Add(account);
            tables.Add(Metadata("contact", 2));
            var byName = tables.ToDictionary(entity => entity.LogicalName);
            context.AddExecutionMock<RetrieveEntityRequest>(request => new RetrieveEntityResponse {
                Results = new ParameterCollection { ["EntityMetadata"] = byName[((RetrieveEntityRequest)request).LogicalName] } });
            return context;
        }

        private static EntityMetadata Metadata(string table, int code)
        {
            var entity = new EntityMetadata { LogicalName = table };
            typeof(EntityMetadata).GetProperty("ObjectTypeCode").SetValue(entity, (int?)code);
            typeof(EntityMetadata).GetProperty("PrimaryIdAttribute").SetValue(entity, table + "id");
            typeof(EntityMetadata).GetProperty("Attributes").SetValue(entity, new AttributeMetadata[0]);
            return entity;
        }

        // A published rule in the source environment, exported.
        private static TransportEntry Source(Action<List<Entity>> change = null, Guid? id = null, string name = "Live", params Entity[] extra)
        {
            var ruleId = id ?? Guid.NewGuid(); var rows = RuleRevisionTests.Rule(ruleId, name);
            change?.Invoke(rows);
            var context = RuleTransportExportTests.Prepare(rows, extra);
            RuleRevisionTests.Freeze(context.GetOrganizationService(), ruleId, 4);
            return RuleTransportExportTests.Export(context, ruleId);
        }

        private static ImportResult Import(TransactionalPluginContext context, TransportEntry entry, bool validateOnly = false, bool overwrite = false, Guid? team = null)
        {
            var inputs = new ParameterCollection { { "Entry", entry.Serialize() }, { "SourceEnvironment", "https://source.crm.dynamics.com" } };
            if (validateOnly) inputs["ValidateOnly"] = true;
            if (overwrite) inputs["OverwriteTargetChanges"] = true;
            if (team != null) inputs["OwnerTeamId"] = team.ToString();
            var request = new XrmFakedPluginExecutionContext { Stage = 30, MessageName = "asx_ImportRule", InitiatingUserId = Caller,
                InputParameters = inputs, OutputParameters = new ParameterCollection() };
            context.ExecuteTransactional<RuleTransportApi>(request);
            using (var stream = new MemoryStream(Encoding.UTF8.GetBytes((string)request.OutputParameters["Result"])))
                return (ImportResult)new DataContractJsonSerializer(typeof(ImportResult)).ReadObject(stream);
        }

        private static List<Entity> All(IOrganizationService service, string table) =>
            service.RetrieveMultiple(new QueryExpression(table) { ColumnSet = new ColumnSet(true) }).Entities.ToList();

        private static Entity Header(IOrganizationService service, Guid id) => service.Retrieve("asx_rule", id, new ColumnSet(true));

        private static string PublishedMessage(IOrganizationService service, Guid id) =>
            PublishedRules.Read(service, Header(service, id)).Rows.Single(row => row.Entity == "asx_ruleaction").ToSdk().GetAttributeValue<string>("asx_message");

        // A second version of the same source rule: a changed action message, published as version 5.
        private static TransportEntry Changed(TransportEntry entry, string message = "Changed")
        {
            var next = TransportEntry.Parse(entry.Serialize());
            next.Definition.Rows.Single(row => row.Entity == "asx_ruleaction").Attributes["asx_message"] = SnapshotValue.From(message);
            next.Hash = next.Definition.Hash();
            next.Version = entry.Version + 1;
            return next;
        }

        private static Guid OpenDraft(TransactionalPluginContext context, Guid ruleId)
        {
            context.AddExecutionMock<RetrievePrincipalAccessRequest>(_ => new RetrievePrincipalAccessResponse {
                Results = new ParameterCollection { { "AccessRights", AccessRights.ReadAccess | AccessRights.WriteAccess } } });
            var request = new XrmFakedPluginExecutionContext { Stage = 30, MessageName = "asx_OpenRuleDraft", InitiatingUserId = Caller,
                InputParameters = new ParameterCollection { { "RuleId", ruleId.ToString() } }, OutputParameters = new ParameterCollection() };
            context.ExecuteTransactional<RuleRevisionApi>(request);
            return Guid.Parse((string)request.OutputParameters["DraftId"]);
        }

        [Fact]
        public void New_rule_is_created_published_with_the_source_id_and_private_models()
        {
            var entry = Source();
            var context = Target(); var service = context.GetOrganizationService();

            var result = Import(context, entry);

            Assert.Equal("created", result.Outcome);
            Assert.Equal(entry.Id, result.RuleId);
            Assert.Equal("Live", result.Name);
            Assert.Equal(1, result.TargetVersion);
            var header = Header(service, entry.Id);
            Assert.Equal(Published, header.GetAttributeValue<OptionSetValue>("statuscode").Value);
            Assert.Equal(1, header.GetAttributeValue<int>(PublicationSchema.Number));
            Assert.Equal(new EntityReference("systemuser", Caller), header.GetAttributeValue<EntityReference>("ownerid"));
            Assert.Null(RuleDrafts.Find(service, entry.Id));
            var root = header.GetAttributeValue<EntityReference>("asx_roottableconfig");
            Assert.NotEqual(entry.Definition.Rows.Single(row => row.Entity == "asx_tableconfig").Id, root.Id);
            Assert.True(service.Retrieve("asx_tableconfig", root.Id, new ColumnSet("asx_isprivate")).GetAttributeValue<bool>("asx_isprivate"));
            Assert.Equal("Live", PublishedMessage(service, entry.Id));
            Assert.Equal(entry.Id, PublishedRules.Read(service, header).RuleId);
        }

        [Fact]
        public void Same_entry_twice_reports_unchanged_and_writes_nothing()
        {
            var entry = Source();
            var context = Target(); var service = context.GetOrganizationService();
            Import(context, entry);

            var result = Import(context, entry);

            Assert.Equal("unchanged", result.Outcome);
            Assert.Equal(1, result.TargetVersion);
            Assert.Single(All(service, PublicationSchema.Revision));
            Assert.Single(All(service, "asx_rule"));
        }

        [Fact]
        public void Changed_entry_updates_and_leaves_no_working_draft()
        {
            var entry = Source();
            var context = Target(); var service = context.GetOrganizationService();
            Import(context, entry);
            var models = All(service, "asx_tableconfig").Count;

            var result = Import(context, Changed(entry));

            Assert.Equal("updated", result.Outcome);
            Assert.Equal(2, result.TargetVersion);
            Assert.Null(RuleDrafts.Find(service, entry.Id));
            Assert.Single(All(service, "asx_rule"));
            Assert.Equal(models, All(service, "asx_tableconfig").Count);
            var header = Header(service, entry.Id);
            Assert.Equal(Published, header.GetAttributeValue<OptionSetValue>("statuscode").Value);
            Assert.Equal(2, header.GetAttributeValue<int>(PublicationSchema.Number));
            Assert.Equal("Changed", PublishedMessage(service, entry.Id));
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void Open_working_draft_is_a_conflict_unless_overwrite(bool overwrite)
        {
            var entry = Source();
            var context = Target(); var service = context.GetOrganizationService();
            Import(context, entry);
            OpenDraft(context, entry.Id);

            var result = Import(context, Changed(entry), overwrite: overwrite);

            if (!overwrite)
            {
                Assert.Equal("conflict", result.Outcome);
                Assert.Contains("working draft", Assert.Single(result.Messages));
                Assert.NotNull(RuleDrafts.Find(service, entry.Id));
                Assert.Equal("Live", PublishedMessage(service, entry.Id));
                return;
            }
            Assert.Equal("updated", result.Outcome);
            Assert.Null(RuleDrafts.Find(service, entry.Id));
            Assert.Single(All(service, "asx_rule"));
            Assert.Equal("Changed", PublishedMessage(service, entry.Id));
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void Rule_published_in_the_target_is_a_conflict_unless_overwrite(bool overwrite)
        {
            var entry = Source();
            var context = Target(); var service = context.GetOrganizationService();
            Import(context, entry);
            RuleRevisionTests.Freeze(service, entry.Id, 2); // a publish made in the target carries no source hash

            var result = Import(context, Changed(entry), overwrite: overwrite);

            if (!overwrite)
            {
                Assert.Equal("conflict", result.Outcome);
                Assert.Contains("published in this environment", Assert.Single(result.Messages));
                Assert.Equal(2, result.TargetVersion);
                return;
            }
            Assert.Equal("updated", result.Outcome);
            Assert.Equal(3, result.TargetVersion);
            Assert.Equal("Changed", PublishedMessage(service, entry.Id));
        }

        [Fact]
        public void Same_name_other_id_same_rule_set_is_a_collision()
        {
            var billing = new Entity("asx_ruleset", Guid.NewGuid()) { ["asx_name"] = "Billing" };
            var entry = Source(extra: new[] { billing }, change: rows => rows[0]["asx_ruleset"] = billing.ToEntityReference());
            var other = new Entity("asx_rule", Guid.NewGuid()) { ["asx_name"] = "Live", ["asx_tablelogicalname"] = "account",
                ["statuscode"] = new OptionSetValue(1), ["asx_ruleset"] = billing.ToEntityReference() };
            var context = Target(billing, other); var service = context.GetOrganizationService();

            var result = Import(context, entry);

            Assert.Equal("collision", result.Outcome);
            Assert.Contains("Billing", Assert.Single(result.Messages));
            Assert.Null(service.RetrieveMultiple(new QueryExpression("asx_rule") { Criteria = { Conditions = {
                new ConditionExpression("asx_ruleid", ConditionOperator.Equal, entry.Id) } } }).Entities.SingleOrDefault());

            // The same name in another rule set is a different rule.
            service.Update(new Entity("asx_rule", other.Id) { ["asx_ruleset"] = null });
            Assert.Equal("created", Import(context, entry).Outcome);
        }

        [Fact]
        public void Rule_set_matches_trimmed_and_case_insensitive_and_is_created_when_missing()
        {
            var sourceSet = new Entity("asx_ruleset", Guid.NewGuid()) { ["asx_name"] = "Billing " };
            var entry = Source(extra: new[] { sourceSet }, change: rows => rows[0]["asx_ruleset"] = sourceSet.ToEntityReference());
            var opsSet = new Entity("asx_ruleset", Guid.NewGuid()) { ["asx_name"] = "Ops" };
            var second = Source(name: "Second", extra: new[] { opsSet }, change: rows => rows[0]["asx_ruleset"] = opsSet.ToEntityReference());
            var billing = new Entity("asx_ruleset", Guid.NewGuid()) { ["asx_name"] = "billing" };
            var context = Target(billing); var service = context.GetOrganizationService();

            Import(context, entry);
            Import(context, second);

            Assert.Equal(billing.Id, Header(service, entry.Id).GetAttributeValue<EntityReference>("asx_ruleset").Id);
            var sets = All(service, "asx_ruleset");
            Assert.Equal(2, sets.Count);
            var ops = sets.Single(set => set.Id != billing.Id);
            Assert.Equal("Ops", ops.GetAttributeValue<string>("asx_name"));
            Assert.Equal(ops.Id, Header(service, second.Id).GetAttributeValue<EntityReference>("asx_ruleset").Id);
        }

        [Fact]
        public void Rerun_after_a_failed_rule_reports_earlier_rules_unchanged()
        {
            var contact = Guid.NewGuid();
            var first = Source(name: "First");
            var second = Source(name: "Second", change: rows => {
                rows[2]["asx_comparisoncolumn"] = "primarycontactid"; rows[2]["asx_comparisonvalue"] = contact.ToString(); });
            var context = Target(); var service = context.GetOrganizationService();

            Assert.Equal("created", Import(context, first).Outcome);
            Assert.Throws<InvalidPluginExecutionException>(() => Import(context, second));
            service.Create(new Entity("contact", contact));

            Assert.Equal("unchanged", Import(context, first).Outcome);
            Assert.Equal("created", Import(context, second).Outcome);
        }

        [Fact]
        public void Newer_source_engine_is_refused_naming_both_versions()
        {
            var entry = Source(); entry.EngineVersion = "0.1.1.0";
            var context = Target(); var service = context.GetOrganizationService();

            var error = Assert.Throws<InvalidPluginExecutionException>(() => Import(context, entry));

            Assert.Equal("This package was exported by engine 0.1.1.0; this environment runs 0.1.0.2. Upgrade the engine first.", error.Message);
            Assert.Empty(All(service, "asx_rule"));
            entry.EngineVersion = "0.1.0.1";
            Assert.Equal("created", Import(context, entry).Outcome);
        }

        [Fact]
        public void Validation_failure_rolls_back_the_rule()
        {
            var entry = Source(rows => rows[2]["asx_comparisoncolumn"] = "nosuchcolumn");
            var context = Target(); var service = context.GetOrganizationService();

            var error = Assert.Throws<InvalidPluginExecutionException>(() => Import(context, entry));

            Assert.StartsWith("This rule can't be published until these problems are fixed:", error.Message);
            Assert.Empty(All(service, "asx_rule"));
            Assert.Empty(All(service, PublicationSchema.Revision));
        }

        [Fact]
        public void Validate_only_throws_on_validation_failure()
        {
            var entry = Source(rows => rows[2]["asx_comparisoncolumn"] = "nosuchcolumn");
            var context = Target();

            var error = Assert.Throws<InvalidPluginExecutionException>(() => Import(context, entry, validateOnly: true));

            Assert.StartsWith("This rule can't be published until these problems are fixed:", error.Message);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void Missing_record_reference_is_refused(bool validateOnly)
        {
            var contact = Guid.NewGuid();
            var entry = Source(rows => { rows[2]["asx_comparisoncolumn"] = "primarycontactid"; rows[2]["asx_comparisonvalue"] = contact.ToString(); });
            var context = Target(); var service = context.GetOrganizationService();

            var error = Assert.Throws<InvalidPluginExecutionException>(() => Import(context, entry, validateOnly: validateOnly));

            Assert.Equal($"Rule Live refers to contact record {contact}, which does not exist in this environment.", error.Message);
            Assert.Empty(All(service, "asx_rule"));
        }

        [Fact]
        public void Record_reference_with_unknown_table_is_reported_and_import_continues()
        {
            var entry = Source();
            var record = Guid.NewGuid();
            entry.RecordReferences.Add(new RecordReference { RowEntity = "asx_rulecondition", RowId = Guid.NewGuid(), Attribute = "asx_expressionfilters", RecordId = record });
            var context = Target();

            var result = Import(context, entry);

            Assert.Equal("created", result.Outcome);
            Assert.Equal($"Could not check record {record} in asx_expressionfilters: its table is unknown.", Assert.Single(result.Messages));
        }

        [Fact]
        public void Validate_only_writes_nothing_and_reports_would_create()
        {
            var set = new Entity("asx_ruleset", Guid.NewGuid()) { ["asx_name"] = "Billing" };
            var id = Guid.NewGuid();
            var schedule = new Entity("asx_ruleschedule", Guid.NewGuid()) { ["asx_rule"] = new EntityReference("asx_rule", id), ["asx_on"] = true,
                ["asx_pattern"] = new OptionSetValue(1), ["asx_every"] = 1 };
            var entry = Source(id: id, extra: new[] { set, schedule }, change: rows => rows[0]["asx_ruleset"] = set.ToEntityReference());
            var context = Target(); var service = context.GetOrganizationService();

            var result = Import(context, entry, validateOnly: true);

            Assert.Equal("wouldCreate", result.Outcome);
            Assert.Null(result.TargetVersion);
            Assert.Empty(All(service, "asx_rule"));
            Assert.Empty(All(service, "asx_ruleset"));
            Assert.Empty(All(service, "asx_ruleschedule"));
            Assert.Empty(All(service, PublicationSchema.Revision));

            Import(context, entry);
            var again = Import(context, Changed(entry), validateOnly: true);
            Assert.Equal("wouldUpdate", again.Outcome);
            Assert.Equal(1, again.TargetVersion);
            Assert.Single(All(service, PublicationSchema.Revision));
            Assert.Equal("Live", PublishedMessage(service, entry.Id));
        }

        [Fact]
        public void Revision_carries_source_environment_version_and_hash()
        {
            var entry = Source();
            var context = Target(); var service = context.GetOrganizationService();

            Import(context, entry);

            var revision = Assert.Single(All(service, PublicationSchema.Revision));
            Assert.Equal("https://source.crm.dynamics.com", revision.GetAttributeValue<string>(PublicationSchema.SourceEnvironment));
            Assert.Equal(4, revision.GetAttributeValue<int>(PublicationSchema.SourceVersion));
            Assert.Equal(entry.Hash, revision.GetAttributeValue<string>(PublicationSchema.SourceHash));
            Assert.Equal(1, revision.GetAttributeValue<int>("asx_version"));
        }

        [Fact]
        public void Schedule_definition_is_created_updated_and_removed()
        {
            var id = Guid.NewGuid();
            var schedule = new Entity("asx_ruleschedule", Guid.NewGuid()) { ["asx_rule"] = new EntityReference("asx_rule", id), ["asx_on"] = true,
                ["asx_pattern"] = new OptionSetValue(4), ["asx_timeofday"] = "06:30",
                ["asx_daysofweek"] = new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue(1), new OptionSetValue(5) }),
                ["asx_nextrunon"] = new DateTime(2026, 10, 20, 6, 30, 0) };
            var entry = Source(id: id, extra: new[] { schedule });
            var context = Target(); var service = context.GetOrganizationService();

            Import(context, entry);
            var created = Assert.Single(All(service, "asx_ruleschedule"));
            Assert.Equal(id, created.GetAttributeValue<EntityReference>("asx_rule").Id);
            Assert.True(created.GetAttributeValue<bool>("asx_on"));
            Assert.Equal(4, created.GetAttributeValue<OptionSetValue>("asx_pattern").Value);
            Assert.Equal("06:30", created.GetAttributeValue<string>("asx_timeofday"));
            Assert.Equal(new[] { 1, 5 }, created.GetAttributeValue<OptionSetValueCollection>("asx_daysofweek").Select(day => day.Value).OrderBy(day => day));
            Assert.False(created.Contains("asx_nextrunon"));

            var next = Changed(entry); next.Schedule.On = false; next.Schedule.TimeOfDay = "07:00"; next.Schedule.DaysOfWeek = "2";
            Import(context, next);
            var updated = Assert.Single(All(service, "asx_ruleschedule"));
            Assert.Equal(created.Id, updated.Id);
            Assert.False(updated.GetAttributeValue<bool>("asx_on"));
            Assert.Equal("07:00", updated.GetAttributeValue<string>("asx_timeofday"));
            Assert.Equal(new[] { 2 }, updated.GetAttributeValue<OptionSetValueCollection>("asx_daysofweek").Select(day => day.Value));

            var last = Changed(next, "Third"); last.Schedule = null;
            Import(context, last);
            Assert.Empty(All(service, "asx_ruleschedule"));
        }

        private static TransportEntry Copy(TransportEntry entry) => TransportEntry.Parse(entry.Serialize());

        private static Entity WeeklySchedule(Guid ruleId) => new Entity("asx_ruleschedule", Guid.NewGuid()) {
            ["asx_rule"] = new EntityReference("asx_rule", ruleId), ["asx_on"] = true, ["asx_pattern"] = new OptionSetValue(4), ["asx_timeofday"] = "06:30",
            ["asx_daysofweek"] = new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue(1) }) };

        [Fact]
        public void Rule_set_only_change_updates_without_a_new_revision_and_a_rerun_is_unchanged()
        {
            var entry = Source();
            var context = Target(); var service = context.GetOrganizationService();
            Import(context, entry);
            var moved = Copy(entry); moved.RuleSet = "Billing";

            var result = Import(context, moved);

            Assert.Equal("updated", result.Outcome);
            Assert.Equal("Definition unchanged; rule set updated.", Assert.Single(result.Messages));
            Assert.Equal(1, result.TargetVersion);
            Assert.Single(All(service, PublicationSchema.Revision));
            var set = Assert.Single(All(service, "asx_ruleset"));
            Assert.Equal(set.Id, Header(service, entry.Id).GetAttributeValue<EntityReference>("asx_ruleset").Id);
            Assert.Equal("unchanged", Import(context, moved).Outcome);

            var removed = Copy(entry);
            Assert.Equal("updated", Import(context, removed).Outcome);
            Assert.Null(Header(service, entry.Id).GetAttributeValue<EntityReference>("asx_ruleset"));
        }

        [Fact]
        public void Schedule_switched_off_in_source_switches_off_the_target_schedule()
        {
            var id = Guid.NewGuid();
            var entry = Source(id: id, extra: new[] { WeeklySchedule(id) });
            var context = Target(); var service = context.GetOrganizationService();
            Import(context, entry);
            var off = Copy(entry); off.Schedule.On = false;

            var result = Import(context, off);

            Assert.Equal("updated", result.Outcome);
            Assert.Equal("Definition unchanged; schedule updated.", Assert.Single(result.Messages));
            Assert.Single(All(service, PublicationSchema.Revision));
            Assert.False(Assert.Single(All(service, "asx_ruleschedule")).GetAttributeValue<bool>("asx_on"));
            Assert.Equal("unchanged", Import(context, off).Outcome);
        }

        [Fact]
        public void Validate_only_reports_would_update_for_rule_set_and_schedule_changes_and_writes_nothing()
        {
            var id = Guid.NewGuid();
            var entry = Source(id: id, extra: new[] { WeeklySchedule(id) });
            var context = Target(); var service = context.GetOrganizationService();
            Import(context, entry);
            var changed = Copy(entry); changed.RuleSet = "Billing"; changed.Schedule.TimeOfDay = "08:00";

            var result = Import(context, changed, validateOnly: true);

            Assert.Equal("wouldUpdate", result.Outcome);
            Assert.Equal("Definition unchanged; rule set and schedule updated.", Assert.Single(result.Messages));
            Assert.Empty(All(service, "asx_ruleset"));
            Assert.Null(Header(service, entry.Id).GetAttributeValue<EntityReference>("asx_ruleset"));
            Assert.Equal("06:30", Assert.Single(All(service, "asx_ruleschedule")).GetAttributeValue<string>("asx_timeofday"));
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void Archived_rule_is_a_conflict_unless_overwrite(bool overwrite)
        {
            var entry = Source();
            var context = Target(); var service = context.GetOrganizationService();
            Import(context, entry);
            service.Update(new Entity("asx_rule", entry.Id) { ["statuscode"] = new OptionSetValue(2) });

            var result = Import(context, entry, overwrite: overwrite);

            if (!overwrite)
            {
                Assert.Equal("conflict", result.Outcome);
                Assert.Equal("Live was archived in this environment.", Assert.Single(result.Messages));
                Assert.Equal(2, Header(service, entry.Id).GetAttributeValue<OptionSetValue>("statuscode").Value);
                Assert.Single(All(service, PublicationSchema.Revision));
                return;
            }
            Assert.Equal("updated", result.Outcome);
            Assert.Equal(2, result.TargetVersion);
            Assert.Equal(Published, Header(service, entry.Id).GetAttributeValue<OptionSetValue>("statuscode").Value);
            Assert.Null(RuleDrafts.Find(service, entry.Id));
        }

        [Fact]
        public void Rule_never_published_in_the_target_is_a_conflict()
        {
            var entry = Source();
            var local = new Entity("asx_rule", entry.Id) { ["asx_name"] = "Live", ["asx_tablelogicalname"] = "account", ["statuscode"] = new OptionSetValue(1) };
            var context = Target(local);

            var result = Import(context, entry);

            Assert.Equal("conflict", result.Outcome);
            Assert.Equal("Live exists in this environment but was never published or imported.", Assert.Single(result.Messages));
            Assert.Null(result.TargetVersion);
        }

        [Fact]
        public void Changed_business_table_is_refused()
        {
            var entry = Source();
            var context = Target(); var service = context.GetOrganizationService();
            Import(context, entry);
            service.Update(new Entity("asx_rule", entry.Id) { ["asx_tablelogicalname"] = "contact" });

            var error = Assert.Throws<InvalidPluginExecutionException>(() => Import(context, Changed(entry)));

            Assert.Equal("Rule Live runs on contact in this environment and on account in the package. A rule's business table cannot be changed.", error.Message);
            Assert.Single(All(service, PublicationSchema.Revision));
            Assert.Null(RuleDrafts.Find(service, entry.Id));
        }

        [Fact]
        public void Owner_team_owns_new_rows_when_given()
        {
            var entry = Source();
            var team = new Entity("team", Guid.NewGuid());
            var context = Target(team); var service = context.GetOrganizationService();

            Import(context, entry, team: team.Id);

            var owner = new EntityReference("team", team.Id);
            Assert.Equal(owner, Header(service, entry.Id).GetAttributeValue<EntityReference>("ownerid"));
            var graph = RuleSnapshot.Capture(service, entry.Id);
            foreach (var row in graph.Rows.Where(row => row.Entity != "asx_rule"))
                Assert.Equal(owner, service.Retrieve(row.Entity, row.Id, new ColumnSet("ownerid")).GetAttributeValue<EntityReference>("ownerid"));
        }
    }
}
