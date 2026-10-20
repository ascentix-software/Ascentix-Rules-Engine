using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin.DataUpdates;

namespace Ascentix.RulesEngine.Plugin.Publication
{
    public sealed class ImportOptions
    {
        public string SourceEnvironment { get; set; }
        public bool ValidateOnly { get; set; }
        public bool OverwriteTargetChanges { get; set; }
        public Guid? OwnerTeamId { get; set; }
        public IReadOnlyList<IDataUpdate> Updates { get; set; }
    }

    /// <summary>What importing one rule did. Outcome: created, updated, unchanged, conflict, collision, wouldCreate or wouldUpdate.</summary>
    [DataContract]
    public sealed class ImportResult
    {
        [DataMember] public Guid RuleId { get; set; }
        [DataMember] public string Name { get; set; }
        [DataMember] public string Outcome { get; set; }
        [DataMember] public List<string> Messages { get; set; } = new List<string>();
        /// <summary>The rule's published version in this environment after the import; null when it has none.</summary>
        [DataMember] public int? TargetVersion { get; set; }

        public string Serialize()
        {
            using (var stream = new MemoryStream())
            {
                new DataContractJsonSerializer(typeof(ImportResult)).WriteObject(stream, this);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }
    }

    /// <summary>
    /// Imports one rule from a transport entry the way an admin would by hand: the definition goes into the rule
    /// (a new header) or a working draft (an existing one) and is published through the normal publish path.
    /// Every check runs before the first write, so a refused rule leaves nothing behind.
    /// </summary>
    public static class RuleImport
    {
        public static ImportResult Run(IPluginExecutionContext context, IOrganizationService service, TransportEntry entry, ImportOptions options)
        {
            var installed = TransportEntry.InstalledEngineVersion(service);
            if (!Version.TryParse(entry.EngineVersion, out var exportedBy))
                throw new InvalidPluginExecutionException("The rule package entry cannot be read.");
            if (Normalize(exportedBy) > Normalize(Version.Parse(installed)))
                throw new InvalidPluginExecutionException($"This package was exported by engine {entry.EngineVersion}; this environment runs {installed}. Upgrade the engine first.");

            // The entry is caller input: only the definition is used, cut down to what a capture carries, and its hash
            // and record ids are worked out here rather than read from the entry.
            var definition = Captured(RuleDrafts.Reidentify(entry.Definition, entry.Id));
            RequireSelfContained(definition);
            var hash = definition.Hash();
            var result = new ImportResult { RuleId = entry.Id, Name = entry.Name };
            var setName = string.IsNullOrWhiteSpace(entry.RuleSet) ? null : entry.RuleSet.Trim();
            var ruleSet = setName == null ? null : FindRuleSet(service, setName);

            if (setName == null || ruleSet != null)
            {
                var others = new QueryExpression("asx_rule") { ColumnSet = new ColumnSet(false), TopCount = 1 };
                others.Criteria.AddCondition("asx_name", ConditionOperator.Equal, entry.Name);
                others.Criteria.AddCondition("asx_ruleid", ConditionOperator.NotEqual, entry.Id);
                others.Criteria.AddCondition(PublicationSchema.DraftOf, ConditionOperator.Null);
                if (ruleSet == null) others.Criteria.AddCondition(PublicationSchema.RuleSet, ConditionOperator.Null);
                else others.Criteria.AddCondition(PublicationSchema.RuleSet, ConditionOperator.Equal, ruleSet.Id);
                if (service.RetrieveMultiple(others).Entities.Count > 0)
                {
                    result.Outcome = "collision";
                    result.Messages.Add($"Another rule named {entry.Name} is already {(setName == null ? "outside any rule set" : "in rule set " + setName)} in this environment.");
                    return result;
                }
            }

            var existing = new QueryExpression("asx_rule") { ColumnSet = new ColumnSet(true), TopCount = 1 };
            existing.Criteria.AddCondition("asx_ruleid", ConditionOperator.Equal, entry.Id);
            var header = service.RetrieveMultiple(existing).Entities.SingleOrDefault();
            Entity draft = null;
            if (header != null)
            {
                draft = RuleDrafts.Find(service, header.Id);
                var pointer = header.GetAttributeValue<EntityReference>(PublicationSchema.Pointer);
                var sourceHash = pointer == null ? null : service.Retrieve(PublicationSchema.Revision, pointer.Id,
                    new ColumnSet(PublicationSchema.SourceHash)).GetAttributeValue<string>(PublicationSchema.SourceHash);
                if (pointer != null) result.TargetVersion = header.GetAttributeValue<int>(PublicationSchema.Number);
                var status = header.GetAttributeValue<OptionSetValue>("statuscode")?.Value;
                if (!options.OverwriteTargetChanges && status == (int)RuleStatus.Archived)
                {
                    result.Outcome = "conflict";
                    result.Messages.Add($"{entry.Name} was archived in this environment.");
                    return result;
                }
                if (!options.OverwriteTargetChanges && status != (int)RuleStatus.Published && pointer != null)
                {
                    result.Outcome = "conflict";
                    result.Messages.Add($"{entry.Name} was unpublished in this environment.");
                    return result;
                }
                if (draft == null && status == (int)RuleStatus.Published && sourceHash != null && sourceHash == hash)
                    return Unchanged(context, service, entry, header, setName, ruleSet, options, result);
                if (!options.OverwriteTargetChanges && (draft != null || sourceHash == null))
                {
                    result.Outcome = "conflict";
                    result.Messages.Add(draft != null ? $"Rule {entry.Name} has an open working draft in this environment."
                        : pointer == null ? $"{entry.Name} exists in this environment but was never published or imported."
                        : $"Rule {entry.Name} was published in this environment, not imported.");
                    return result;
                }
                var table = definition.Rows.Single(row => row.Entity == "asx_rule").ToSdk().GetAttributeValue<string>("asx_tablelogicalname");
                if (!string.Equals(table, header.GetAttributeValue<string>("asx_tablelogicalname"), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidPluginExecutionException($"Rule {entry.Name} runs on {header.GetAttributeValue<string>("asx_tablelogicalname")} in this environment and on {table} in the package. A rule's business table cannot be changed.");
            }

            if (header == null && !HoldsPrivilege(service, context.InitiatingUserId, "prvCreateasx_rule"))
                throw new InvalidPluginExecutionException("Creating rules needs the Create privilege on Rule.");
            RulePublication.RequireNoPendingDataUpdate(context, service, options.Updates);
            RulePublication.Validate(service, definition, entry.Id);
            CheckRecords(service, entry.Name, definition, result);
            if (options.ValidateOnly)
            {
                result.Outcome = header == null ? "wouldCreate" : "wouldUpdate";
                return result;
            }

            ruleSet = EnsureRuleSet(service, setName, ruleSet);
            var owner = options.OwnerTeamId is Guid team ? new EntityReference("team", team) : new EntityReference("systemuser", context.InitiatingUserId);
            Guid? draftId = null;
            var revision = header == null
                ? Create(context, service, entry, definition, ruleSet, owner, options.Updates)
                : Update(context, service, header, draft, definition, ruleSet, options.Updates, out draftId);

            PublicationCoordinator.Internal(context, service, writer => writer.Update(new Entity(PublicationSchema.Revision, revision.Id) {
                [PublicationSchema.SourceEnvironment] = options.SourceEnvironment,
                [PublicationSchema.SourceVersion] = entry.Version,
                [PublicationSchema.SourceHash] = hash }));
            // While the working draft exists the schedule plug-in also reads the draft's triggers.
            WriteSchedule(service, entry);
            if (draftId != null)
            {
                var stale = service.Retrieve("asx_rule", draftId.Value, new ColumnSet(true));
                PublicationCoordinator.Internal(context, service, writer => RuleDrafts.DeleteContents(writer, stale));
                PublicationCoordinator.Internal(context, service, writer => writer.Delete("asx_rule", stale.Id), reconcile: true);
            }

            result.Outcome = header == null ? "created" : "updated";
            result.TargetVersion = revision.GetAttributeValue<int>("asx_version");
            return result;
        }

        // The definition is current. Rule set and schedule are the source's too, but outside the hash: bring them in line.
        private static ImportResult Unchanged(IPluginExecutionContext context, IOrganizationService service, TransportEntry entry, Entity header,
            string setName, Entity ruleSet, ImportOptions options, ImportResult result)
        {
            var currentSet = header.GetAttributeValue<EntityReference>(PublicationSchema.RuleSet);
            var setChanged = setName == null ? currentSet != null : currentSet == null || ruleSet == null || currentSet.Id != ruleSet.Id;
            var scheduleChanged = !SameSchedule(RuleTransportApi.Schedule(service, header.Id), entry.Schedule);
            if (!setChanged && !scheduleChanged)
            {
                result.Outcome = "unchanged";
                return result;
            }
            result.Messages.Add("Definition unchanged; " + (setChanged && scheduleChanged ? "rule set and schedule" : setChanged ? "rule set" : "schedule") + " updated.");
            if (options.ValidateOnly)
            {
                result.Outcome = "wouldUpdate";
                return result;
            }
            if (setChanged)
            {
                ruleSet = EnsureRuleSet(service, setName, ruleSet);
                PublicationCoordinator.Internal(context, service, writer => writer.Update(new Entity("asx_rule", header.Id) {
                    [PublicationSchema.RuleSet] = ruleSet?.ToEntityReference() }));
            }
            if (scheduleChanged) WriteSchedule(service, entry);
            result.Outcome = "updated";
            return result;
        }

        private static bool SameSchedule(TransportSchedule current, TransportSchedule wanted) =>
            current == null || wanted == null ? current == wanted :
            current.On == wanted.On && current.Pattern == wanted.Pattern && current.Every == wanted.Every &&
            current.TimeOfDay == wanted.TimeOfDay && current.DaysOfWeek == wanted.DaysOfWeek && current.DayOfMonth == wanted.DayOfMonth;

        private static Entity EnsureRuleSet(IOrganizationService service, string setName, Entity ruleSet)
        {
            if (ruleSet != null || setName == null) return ruleSet;
            var created = new Entity(PublicationSchema.RuleSet) { ["asx_name"] = setName };
            created.Id = service.Create(created);
            return created;
        }

        private static Version Normalize(Version version) =>
            new Version(version.Major, version.Minor, Math.Max(version.Build, 0), Math.Max(version.Revision, 0));

        private static Entity FindRuleSet(IOrganizationService service, string name) =>
            RuleSnapshot.QueryAll(service, new QueryExpression(PublicationSchema.RuleSet) { ColumnSet = new ColumnSet("asx_name") })
                .FirstOrDefault(set => string.Equals(set.GetAttributeValue<string>("asx_name")?.Trim(), name, StringComparison.OrdinalIgnoreCase));

        // A new header with the source id, its definition restored as private copies, then published.
        private static Entity Create(IPluginExecutionContext context, IOrganizationService service, TransportEntry entry, RuleSnapshot definition,
            Entity ruleSet, EntityReference owner, IReadOnlyList<IDataUpdate> updates)
        {
            var source = definition.Rows.Single(row => row.Entity == "asx_rule").ToSdk();
            var header = new Entity("asx_rule", entry.Id) {
                ["asx_name"] = entry.Name, ["asx_tablelogicalname"] = source.GetAttributeValue<string>("asx_tablelogicalname"),
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Draft), ["ownerid"] = owner };
            PublicationCoordinator.Internal(context, service, writer => {
                writer.Create(header);
                RuleRevisionApi.Restore(writer, header, definition);
            });
            var target = new Entity("asx_rule", entry.Id) { ["statuscode"] = new OptionSetValue((int)RuleStatus.Published) };
            var revision = RulePublication.Publish(context, service, target, updates);
            target[PublicationSchema.RuleSet] = ruleSet?.ToEntityReference();
            // The publish write, as the publish plug-in's own Update would make it: registration reconciles enforcement.
            PublicationCoordinator.Internal(context, service, writer => writer.Update(target), reconcile: true);
            return revision;
        }

        // The definition goes into a working draft (the open one when overwriting), which is published. The caller deletes the draft.
        private static Entity Update(IPluginExecutionContext context, IOrganizationService service, Entity header, Entity openDraft,
            RuleSnapshot definition, Entity ruleSet, IReadOnlyList<IDataUpdate> updates, out Guid? draftId)
        {
            Guid id;
            if (openDraft != null)
            {
                id = openDraft.Id;
                PublicationCoordinator.Internal(context, service, writer => {
                    RuleRevisionApi.Restore(writer, openDraft, RuleDrafts.Reidentify(definition, openDraft.Id));
                    writer.Update(new Entity("asx_rule", openDraft.Id) {
                        [PublicationSchema.DraftBaseVersion] = header.GetAttributeValue<int>(PublicationSchema.Number) });
                });
            }
            else id = RuleDrafts.Copy(service, context, header, definition, workingDraft: true);
            draftId = id;
            // Publishing a draft writes the original header itself (pointer, number, status, name) with registration.
            var revision = RulePublication.Publish(context, service, new Entity("asx_rule", id) {
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published) }, updates);
            var live = LiveColumns(header, definition);
            live[PublicationSchema.RuleSet] = ruleSet?.ToEntityReference();
            PublicationCoordinator.Internal(context, service, writer => writer.Update(live), reconcile: true);
            return revision;
        }

        // The hub keeps the published draft, which the schedule plug-in reads; import deletes it, so the original's own
        // scalar columns (triggers, scope, time zone...) take the published values. Lookups into configuration rows are
        // left alone: they name the deleted draft's private models. Name and status were written by the publish.
        private static Entity LiveColumns(Entity header, RuleSnapshot definition)
        {
            bool Copied(string field, object value) =>
                field.StartsWith("asx_", StringComparison.Ordinal) && field != "asx_ruleid" && field != "asx_name" &&
                field != "asx_tablelogicalname" && field != PublicationSchema.PublishHash && !PublicationSchema.IsProtected(field) &&
                !(value is EntityReference reference && PublicationSchema.IsConfig(reference.LogicalName));
            var patch = new Entity("asx_rule", header.Id);
            foreach (var attribute in definition.Rows.Single(row => row.Entity == "asx_rule").ToSdk().Attributes)
                if (Copied(attribute.Key, attribute.Value)) patch[attribute.Key] = attribute.Value;
            foreach (var attribute in header.Attributes)
                if (!patch.Contains(attribute.Key) && Copied(attribute.Key, attribute.Value)) patch[attribute.Key] = null;
            return patch;
        }

        // Schedules belong to the published rule (never a draft row) and a rule has at most one.
        // Written through the platform so the schedule plug-in validates it and computes the next run.
        private static void WriteSchedule(IOrganizationService service, TransportEntry entry)
        {
            var query = new QueryExpression("asx_ruleschedule") { ColumnSet = new ColumnSet(false), TopCount = 1 };
            query.Criteria.AddCondition("asx_rule", ConditionOperator.Equal, entry.Id);
            var current = service.RetrieveMultiple(query).Entities.FirstOrDefault();
            var schedule = entry.Schedule;
            if (schedule == null)
            {
                if (current != null) service.Delete(current.LogicalName, current.Id);
                return;
            }
            var row = new Entity("asx_ruleschedule", current?.Id ?? Guid.Empty) {
                ["asx_on"] = schedule.On,
                ["asx_pattern"] = schedule.Pattern == null ? null : new OptionSetValue(schedule.Pattern.Value),
                ["asx_every"] = schedule.Every,
                ["asx_timeofday"] = schedule.TimeOfDay,
                ["asx_daysofweek"] = string.IsNullOrEmpty(schedule.DaysOfWeek) ? null : new OptionSetValueCollection(
                    schedule.DaysOfWeek.Split(',').Select(day => new OptionSetValue(int.Parse(day.Trim()))).ToList()),
                ["asx_dayofmonth"] = schedule.DayOfMonth };
            if (current != null) service.Update(row);
            else
            {
                row["asx_rule"] = new EntityReference("asx_rule", entry.Id);
                service.Create(row);
            }
        }

        // Import writes as the system user, so a definition row keeps only the columns a capture emits: never an owner,
        // a creator, the row id or publication state.
        private static RuleSnapshot Captured(RuleSnapshot definition)
        {
            foreach (var row in definition.Rows)
                row.Attributes = row.Attributes.Where(a => PublicationSchema.IsCaptured(row.Entity, a.Key)).ToDictionary(a => a.Key, a => a.Value);
            return definition;
        }

        // Every lookup into a configuration table names a row of this definition; anything else would make the import
        // attach the rule to configuration it does not own.
        private static void RequireSelfContained(RuleSnapshot definition)
        {
            var rows = new HashSet<string>(definition.Rows.Select(row => row.Entity + "|" + row.Id));
            foreach (var value in definition.Rows.SelectMany(row => row.Attributes.Values))
                if (value?.Kind == "reference" && PublicationSchema.IsConfig(value.Entity) &&
                    !(Guid.TryParse(value.Value, out var id) && rows.Contains(value.Entity + "|" + id)))
                    throw new InvalidPluginExecutionException("The rule package entry refers to configuration outside the rule.");
        }

        private static bool HoldsPrivilege(IOrganizationService service, Guid userId, string privilege) =>
            ((RetrieveUserPrivilegeByPrivilegeNameResponse)service.Execute(new RetrieveUserPrivilegeByPrivilegeNameRequest {
                PrivilegeName = privilege, UserId = userId })).RolePrivileges?.Length > 0;

        // Record ids the definition stores must name records that exist here; an id whose table is unknown is only reported.
        // The ids are found here, against this environment's lookup metadata, not taken from the entry.
        private static void CheckRecords(IOrganizationService service, string ruleName, RuleSnapshot definition, ImportResult result)
        {
            var primaryIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            bool Exists(string table, Guid id)
            {
                if (!primaryIds.TryGetValue(table, out var column))
                    primaryIds[table] = column = ((RetrieveEntityResponse)service.Execute(new RetrieveEntityRequest {
                        LogicalName = table, EntityFilters = EntityFilters.Entity })).EntityMetadata.PrimaryIdAttribute;
                var query = new QueryExpression(table) { ColumnSet = new ColumnSet(false), TopCount = 1 };
                query.Criteria.AddCondition(column, ConditionOperator.Equal, id);
                return service.RetrieveMultiple(query).Entities.Count > 0;
            }
            foreach (var reference in RecordReferenceScanner.Find(definition, RuleTransportApi.LookupTargets(service)))
            {
                if (reference.Tables == null || reference.Tables.Count == 0)
                {
                    result.Messages.Add($"Could not check record {reference.RecordId} in {reference.Attribute}: its table is unknown.");
                    continue;
                }
                if (!reference.Tables.Any(table => Exists(table, reference.RecordId)))
                    throw new InvalidPluginExecutionException(
                        $"Rule {ruleName} refers to {string.Join(" or ", reference.Tables)} record {reference.RecordId}, which does not exist in this environment.");
            }
        }
    }
}
