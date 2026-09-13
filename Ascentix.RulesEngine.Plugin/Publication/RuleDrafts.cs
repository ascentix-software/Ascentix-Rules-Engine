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

        public static void DeleteContents(IOrganizationService service, Guid ruleId)
            => DeleteContents(service, service.Retrieve("asx_rule", ruleId, new ColumnSet(true)));

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
            var rows = service.RetrieveMultiple(query).Entities;
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
                    row[PublicationSchema.DraftStamp] = Guid.NewGuid().ToString();
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
