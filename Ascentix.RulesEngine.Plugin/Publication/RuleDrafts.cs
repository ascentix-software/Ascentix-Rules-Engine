using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Publication;

namespace Ascentix.RulesEngine.Plugin.Publication
{
    public static class RuleDrafts
    {
        public static bool IsDeletingConfiguration(IPluginExecutionContext context)
        {
            // Platform RemoveLink updates run inside the parent Delete. These rows
            // are already in its server-captured cleanup plan; don't stamp or protect
            // them as independent edits. Shared models are never in this plan.
            var target = context.InputParameters.TryGetValue("Target", out var value) ? value as Entity : null;
            if (target == null || context.MessageName != "Update") return false;
            for (var parent = context.ParentContext; parent != null; parent = parent.ParentContext)
            {
                if (parent.MessageName != "Delete" || parent.PrimaryEntityName != "asx_rule" ||
                    !(parent.InputParameters["Target"] is EntityReference rule)) continue;
                var key = "Ascentix.Delete." + rule.Id;
                if (parent.SharedVariables.TryGetValue(key + ".graph", out var json) &&
                    RuleSnapshot.Parse((string)json, rule.Id).Rows.Any(row => row.Entity == target.LogicalName && row.Id == target.Id)) return true;
                if (parent.SharedVariables.TryGetValue(key + ".revisions", out var revisions) &&
                    ((EntityReferenceCollection)revisions).Any(row => row.LogicalName == target.LogicalName && row.Id == target.Id)) return true;
            }
            return false;
        }

        // Dataverse removes ownership links before PreOperation. Capture them without
        // writing in PreValidation; all cleanup stays in the native Delete transaction.
        public static void NativeDelete(IOrganizationService service, IPluginExecutionContext context)
        {
            var id = ((EntityReference)context.InputParameters["Target"]).Id;
            var key = "Ascentix.Delete." + id;
            if (context.Stage == 10)
            {
                var header = service.Retrieve("asx_rule", id, new ColumnSet(true));
                var headers = new List<Entity> { header };
                var draft = Find(service, id);
                if (draft != null) headers.Add(draft);
                var graph = new RuleSnapshot { RuleId = id };
                foreach (var owner in headers) graph.Rows.AddRange(RuleSnapshot.Capture(service, owner, false).Rows);
                graph.Rows = graph.Rows.GroupBy(row => row.Entity + row.Id).Select(group => group.First()).ToList();
                var revisions = new QueryExpression(PublicationSchema.Revision) { ColumnSet = new ColumnSet(false) };
                revisions.Criteria.AddCondition("asx_rule", ConditionOperator.In, headers.Select(row => (object)row.Id).ToArray());
                context.SharedVariables[key + ".graph"] = graph.Serialize();
                context.SharedVariables[key + ".headers"] = new EntityCollection(headers);
                context.SharedVariables[key + ".revisions"] = new EntityReferenceCollection(
                    RuleSnapshot.QueryAll(service, revisions).Select(row => row.ToEntityReference()).ToList());
                context.SharedVariables[key + ".models"] = string.Join(",", PrivateModels(service, graph));
                return;
            }
            object Read(string suffix)
            {
                // PreValidation variables are carried by ParentContext in the later stages.
                for (var current = context; current != null; current = current.ParentContext)
                    if (current.SharedVariables.TryGetValue(key + suffix, out var value)) return value;
                throw new InvalidPluginExecutionException("Rule deletion registration is incomplete. Deploy the rule authoring steps.");
            }
            if (context.Stage == 20)
            {
                var headers = ((EntityCollection)Read(".headers")).Entities;
                PublicationCoordinator.Internal(context, service, writer => {
                    DeleteChildren(writer, RuleSnapshot.Parse((string)Read(".graph"), id));
                    foreach (var draft in headers.Where(header => header.Id != id)) writer.Delete("asx_rule", draft.Id);
                });
            }
            else if (context.Stage == 40)
            {
                var models = new HashSet<Guid>(((string)Read(".models")).Split(',').Where(value => value.Length > 0).Select(Guid.Parse));
                PublicationCoordinator.Internal(context, service, writer => {
                    // Delete revisions after the header so RemoveLink cannot issue
                    // an Update against its in-flight published-revision pointer.
                    foreach (var revision in (EntityReferenceCollection)Read(".revisions")) writer.Delete(revision.LogicalName, revision.Id);
                    RemoveUnusedModels(writer, models);
                });
            }
        }

        public static void DeleteChildren(IOrganizationService service, RuleSnapshot graph)
        {
            var remaining = graph.Rows.Where(row => row.Entity != "asx_rule" && row.Entity != "asx_tableconfig").Select(row => row.ToSdk()).ToList();
            while (remaining.Count > 0)
            {
                var leaves = remaining.Where(row => !remaining.Any(other => other.Id != row.Id &&
                    other.Attributes.Values.OfType<EntityReference>().Any(reference => reference.Id == row.Id))).ToList();
                if (leaves.Count == 0) throw new InvalidPluginExecutionException("The draft contains a configuration ownership cycle.");
                foreach (var row in leaves) { service.Delete(row.LogicalName, row.Id); remaining.Remove(row); }
            }
        }

        public static HashSet<Guid> PrivateModels(IOrganizationService service, RuleSnapshot graph)
        {
            var nodes = RuleSnapshot.QueryAll(service, new QueryExpression("asx_tableconfig") {
                ColumnSet = new ColumnSet("asx_parenttable", "asx_isprivate") });
            var text = graph.Serialize();
            var ids = new HashSet<Guid>(nodes.Where(node => text.IndexOf(node.Id.ToString(), StringComparison.OrdinalIgnoreCase) >= 0).Select(node => node.Id));
            bool expanded;
            do {
                expanded = false;
                foreach (var node in nodes)
                    if (ids.Contains(node.Id) || ids.Contains(node.GetAttributeValue<EntityReference>("asx_parenttable")?.Id ?? Guid.Empty)) {
                        expanded |= ids.Add(node.Id);
                        if (node.GetAttributeValue<EntityReference>("asx_parenttable") is EntityReference parent) expanded |= ids.Add(parent.Id);
                    }
            } while (expanded);
            ids.IntersectWith(nodes.Where(node => node.GetAttributeValue<bool>("asx_isprivate")).Select(node => node.Id));
            return ids;
        }

        // Remove only this draft's abandoned private nodes, retaining any node another graph uses.
        public static void RemoveUnusedModels(IOrganizationService service, HashSet<Guid> candidates)
        {
            if (candidates.Count == 0) return;
            var rows = PublicationSchema.ConfigTables.SelectMany(table => RuleSnapshot.QueryAll(service,
                new QueryExpression(table) { ColumnSet = new ColumnSet(true) })).ToList();
            bool removed;
            do {
                removed = false;
                foreach (var node in rows.Where(row => row.LogicalName == "asx_tableconfig" && candidates.Contains(row.Id)).ToList())
                {
                    if (rows.Any(row => row.Id != node.Id && row.Attributes.Where(a => a.Key.StartsWith("asx_", StringComparison.Ordinal)).Any(a =>
                        (a.Value is EntityReference reference && reference.Id == node.Id) ||
                        (a.Value is string value && value.IndexOf(node.Id.ToString(), StringComparison.OrdinalIgnoreCase) >= 0)))) continue;
                    service.Delete(node.LogicalName, node.Id);
                    rows.Remove(node); removed = true;
                }
            } while (removed);
        }

        // Run only inside the deletion API, BEFORE issuing the header Delete request.
        public static void DeleteContents(IOrganizationService service, Entity header)
        {
            var ruleId = header.Id;
            var graph = RuleSnapshot.Capture(service, header, includeConfigs: false);
            var models = PrivateModels(service, graph);
            DeleteChildren(service, graph);
            var clear = new Entity("asx_rule", ruleId);
            foreach (var field in new[] { "asx_roottableconfig", PublicationSchema.Pointer })
                if (header.GetAttributeValue<EntityReference>(field) != null) clear[field] = null;
            if (clear.Attributes.Count > 0) service.Update(clear);
            var query = new QueryExpression(PublicationSchema.Revision) { ColumnSet = new ColumnSet(false) };
            query.Criteria.AddCondition("asx_rule", ConditionOperator.Equal, ruleId);
            foreach (var revision in RuleSnapshot.QueryAll(service, query)) service.Delete(PublicationSchema.Revision, revision.Id);
            RemoveUnusedModels(service, models);
        }

        public static Entity Find(IOrganizationService service, Guid ruleId)
        {
            var query = new QueryExpression("asx_rule") { TopCount = 2, ColumnSet = new ColumnSet(true) };
            query.Criteria.AddCondition(PublicationSchema.DraftOf, ConditionOperator.Equal, ruleId);
            // During Delete, the platform can return the in-flight header through
            // the self-referential relationship. It must never be deleted again as
            // its own working copy. Check identity and ownership at the boundary.
            query.Criteria.AddCondition("asx_ruleid", ConditionOperator.NotEqual, ruleId);
            var rows = service.RetrieveMultiple(query).Entities.Where(row => row.Id != ruleId).ToList();
            if (rows.Any(row => row.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf)?.Id != ruleId))
                throw new InvalidPluginExecutionException("The working draft lookup returned a rule belonging to a different owner.");
            if (rows.Count > 1) throw new InvalidPluginExecutionException("This rule has more than one working draft.");
            return rows.SingleOrDefault();
        }

        public static bool RequiresWorkingDraft(IOrganizationService service, Entity header)
            => header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf) == null &&
                (header.GetAttributeValue<OptionSetValue>("statuscode")?.Value == 753840000 ||
                 header.GetAttributeValue<EntityReference>(PublicationSchema.Pointer) != null || Find(service, header.Id) != null);

        public static RuleSnapshot Reidentify(RuleSnapshot source, Guid ruleId)
        {
            var copy = RuleSnapshot.Parse(source.Serialize(), source.RuleId);
            foreach (var row in copy.Rows)
            {
                if (row.Entity == "asx_rule") row.Id = ruleId;
                foreach (var value in row.Attributes.Values)
                    if (value.Kind == "reference" && value.Entity == "asx_rule" && value.Value == source.RuleId.ToString())
                        value.Value = ruleId.ToString();
            }
            copy.RuleId = ruleId;
            return copy;
        }

        public static Guid Open(IOrganizationService service, IPluginExecutionContext context, Entity header)
        {
            if (header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf) != null) return header.Id;
            var existing = Find(service, header.Id);
            if (existing != null) return existing.Id;
            if (header.GetAttributeValue<OptionSetValue>("statuscode")?.Value != 753840000 &&
                header.GetAttributeValue<EntityReference>(PublicationSchema.Pointer) == null) return header.Id;
            var snapshot = PublishedRules.Read(service, header) ?? RuleSnapshot.Capture(service, header.Id);
            return Copy(service, context, header, snapshot, workingDraft: true);
        }

        public static Guid Copy(IOrganizationService service, IPluginExecutionContext context, Entity header, RuleSnapshot snapshot, bool workingDraft)
        {
            var ids = snapshot.Rows.ToDictionary(row => row.Id, row => Guid.NewGuid());
            var modelIds = snapshot.Rows.Where(row => row.Entity == "asx_tableconfig").ToDictionary(row => row.Id, row => ids[row.Id]);
            var draftId = ids[header.Id];
            var rows = new List<Entity>();
            foreach (var source in snapshot.Rows)
            {
                var row = new Entity(source.Entity, ids[source.Id]);
                foreach (var attribute in source.Attributes)
                {
                    var value = attribute.Value.ToSdk();
                    if (value is EntityReference reference && ids.TryGetValue(reference.Id, out var mapped))
                        value = new EntityReference(reference.LogicalName, mapped);
                    else if (value is string text)
                        value = DraftReferenceRemapper.Rewrite(source, attribute.Key, text, modelIds);
                    row[attribute.Key] = value;
                }
                if (source.Entity == "asx_rule")
                {
                    row["statuscode"] = new OptionSetValue(1);
                    if (workingDraft) {
                        row[PublicationSchema.DraftOf] = header.ToEntityReference();
                        row[PublicationSchema.DraftBaseVersion] = header.GetAttributeValue<int>(PublicationSchema.Number);
                    } else row["asx_name"] = "Copy of " + row.GetAttributeValue<string>("asx_name");
                }
                if (source.Entity == "asx_tableconfig") row["asx_isprivate"] = true;
                row["ownerid"] = header.GetAttributeValue<EntityReference>("ownerid") ?? new EntityReference("systemuser", context.InitiatingUserId);
                rows.Add(row);
            }
            PublicationCoordinator.Internal(context, service, writer => {
                while (rows.Count > 0)
                {
                    var ready = rows.Where(row => !row.Attributes.Values.OfType<EntityReference>().Any(reference => rows.Any(other => other.Id == reference.Id))).ToList();
                    if (ready.Count == 0) throw new InvalidPluginExecutionException("The published rule has a configuration cycle.");
                    foreach (var row in ready) { writer.Create(row); rows.Remove(row); }
                }
            });
            return draftId;
        }
    }
}
