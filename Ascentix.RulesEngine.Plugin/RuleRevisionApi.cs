using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin.Publication;

namespace Ascentix.RulesEngine.Plugin
{
    // Main-operation handler for opening, viewing, and discarding a working draft.
    public sealed class RuleRevisionApi : PluginBase
    {
        public RuleRevisionApi() : base(typeof(RuleRevisionApi)) { }
        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            var context = local.PluginExecutionContext;
            var service = local.SystemUserService;
            if (context.MessageName != "asx_OpenRuleDraft" && context.MessageName != "asx_ReadPublishedRule" && context.MessageName != "asx_RestoreRuleDraft" && context.MessageName != "asx_CopyRule" && context.MessageName != "asx_DeleteRule")
                throw new InvalidPluginExecutionException("Unknown rule authoring operation.");
            if (!context.InputParameters.TryGetValue("RuleId", out var raw) || !Guid.TryParse(raw as string, out var ruleId))
                throw new InvalidPluginExecutionException("RuleId is required.");
            if (context.MessageName == "asx_DeleteRule")
            {
                Delete(local, ruleId);
                return;
            }
            var header = service.Retrieve("asx_rule", ruleId, new ColumnSet(true));
            var original = header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf) ?? header.ToEntityReference();
            var access = (RetrievePrincipalAccessResponse)service.Execute(new RetrievePrincipalAccessRequest {
                Principal = new EntityReference("systemuser", context.InitiatingUserId), Target = original });
            if ((access.AccessRights & AccessRights.ReadAccess) == 0)
                throw new InvalidPluginExecutionException("You do not have permission to read this rule.");
            if (context.MessageName != "asx_ReadPublishedRule")
            {
                if (context.MessageName != "asx_CopyRule" && (access.AccessRights & AccessRights.WriteAccess) == 0)
                    throw new InvalidPluginExecutionException("You do not have permission to edit this rule.");
                PublicationCoordinator.Lock(service, context);
            }
            header = service.Retrieve("asx_rule", ruleId, new ColumnSet(true));
            var active = original.Id == ruleId ? header : service.Retrieve("asx_rule", original.Id, new ColumnSet(true));
            if (context.MessageName == "asx_CopyRule") {
                var source = PublishedRules.Read(service, active) ?? RuleSnapshot.Capture(service, active.Id);
                var owner = new Entity("asx_rule", active.Id) { ["ownerid"] = new EntityReference("systemuser", context.InitiatingUserId) };
                context.OutputParameters["NewRuleId"] = RuleDrafts.Copy(service, context, owner, source, workingDraft: false).ToString();
                return;
            }
            if (context.MessageName == "asx_OpenRuleDraft")
            {
                context.OutputParameters["DraftId"] = RuleDrafts.Open(service, context, active).ToString();
                return;
            }
            var snapshot = PublishedRules.Read(service, active);
            if (snapshot == null && active.GetAttributeValue<OptionSetValue>("statuscode")?.Value == 753840000)
                snapshot = RuleSnapshot.Capture(service, active.Id);
            if (snapshot == null) throw new InvalidPluginExecutionException("This rule has not been published.");
            if (context.MessageName == "asx_ReadPublishedRule")
            { context.OutputParameters["Definition"] = snapshot.Serialize(); return; }
            if (context.MessageName != "asx_RestoreRuleDraft") throw new InvalidPluginExecutionException("Unknown revision operation.");
            if (header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf) == null)
                throw new InvalidPluginExecutionException("Open the working draft before discarding its changes.");
            var expected = context.InputParameters.TryGetValue("ExpectedVersion", out var version) ? version as string : null;
            var current = header.RowVersion ?? Convert.ToString(header.GetAttributeValue<long>("versionnumber"));
            if (string.IsNullOrEmpty(expected) || expected != current)
                throw new InvalidPluginExecutionException("This rule changed elsewhere. Reload before discarding its draft.");
            PublicationCoordinator.Internal(context, service, writer => {
                Restore(writer, header, RuleDrafts.Reidentify(snapshot, header.Id));
                writer.Update(new Entity("asx_rule", header.Id) {
                    [PublicationSchema.DraftBaseVersion] = active.GetAttributeValue<int>(PublicationSchema.Number) });
            });
        }

        private static void Delete(ILocalPluginContext local, Guid ruleId)
        {
            var context = local.PluginExecutionContext;
            var service = local.SystemUserService;
            PublicationCoordinator.Lock(service, context);
            var query = new QueryExpression("asx_rule") { ColumnSet = new ColumnSet(true), TopCount = 1 };
            query.Criteria.AddCondition("asx_ruleid", ConditionOperator.Equal, ruleId);
            var header = service.RetrieveMultiple(query).Entities.SingleOrDefault();
            if (header == null) return; // Idempotent, only after a successful absence query.
            var original = header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf) ?? header.ToEntityReference();
            foreach (var target in new[] { original, header.ToEntityReference() }.GroupBy(reference => reference.Id).Select(group => group.First()))
            {
                var access = (RetrievePrincipalAccessResponse)service.Execute(new RetrievePrincipalAccessRequest {
                    Principal = new EntityReference("systemuser", context.InitiatingUserId), Target = target });
                if ((access.AccessRights & (AccessRights.ReadAccess | AccessRights.DeleteAccess)) != (AccessRights.ReadAccess | AccessRights.DeleteAccess))
                    throw new InvalidPluginExecutionException("You do not have permission to delete this rule.");
            }
            // This transaction begins before Dataverse's Delete cascade. All owned
            // links are still available and restrictive lookups can be cleared safely.
            PublicationCoordinator.Internal(context, service, writer => {
                var draft = RuleDrafts.Find(service, ruleId);
                if (draft != null) { RuleDrafts.DeleteContents(writer, draft); writer.Delete("asx_rule", draft.Id); }
                RuleDrafts.DeleteContents(writer, header);
            });
            // Reconcile once against the final state; customer plugins remain enabled.
            PublicationCoordinator.Internal(context, service, writer => writer.Delete("asx_rule", ruleId), reconcile: true);
        }

        public static void Restore(IOrganizationService service, Entity header, RuleSnapshot published)
        {
            var current = RuleSnapshot.Capture(service, header.Id, false);
            var models = RuleDrafts.PrivateModels(service, current);
            RuleDrafts.DeleteChildren(service, current);
            // Shared models must never be rolled back for other rules. Restore a private copy.
            var ids = published.Rows.Where(r => r.Entity != "asx_rule").ToDictionary(r => r.Id, r => Guid.NewGuid());
            var modelIds = published.Rows.Where(r => r.Entity == "asx_tableconfig").ToDictionary(r => r.Id, r => ids[r.Id]);
            Entity Clone(SnapshotRow row)
            {
                var e = new Entity(row.Entity, row.Entity == "asx_rule" ? header.Id : ids[row.Id]);
                foreach (var a in row.Attributes)
                {
                    var value = a.Value.ToSdk();
                    if (value is EntityReference reference && ids.TryGetValue(reference.Id, out var mapped))
                        value = new EntityReference(reference.LogicalName, mapped);
                    else if (value is string text)
                        value = DraftReferenceRemapper.Rewrite(row, a.Key, text, modelIds);
                    e[a.Key] = value;
                }
                if (row.Entity == "asx_tableconfig") e["asx_isprivate"] = true;
                if (row.Entity != "asx_rule" && header.GetAttributeValue<EntityReference>("ownerid") is EntityReference owner)
                    e["ownerid"] = owner;
                return e;
            }
            var creates = published.Rows.Where(r => r.Entity != "asx_rule").Select(Clone).ToList();
            while (creates.Count > 0)
            {
                var ready = creates.Where(r => !r.Attributes.Values.OfType<EntityReference>().Any(reference => creates.Any(x => x.Id == reference.Id))).ToList();
                if (ready.Count == 0) throw new InvalidPluginExecutionException("The published revision contains a configuration cycle.");
                foreach (var row in ready) { service.Create(row); creates.Remove(row); }
            }
            var patch = Clone(published.Rows.Single(r => r.Entity == "asx_rule"));
            patch.Attributes.Remove("statuscode");
            foreach (var field in current.Rows.Single(r => r.Entity == "asx_rule").Attributes.Keys)
                if (field != "statuscode" && !patch.Contains(field)) patch[field] = null;
            patch[PublicationSchema.DraftStamp] = Guid.NewGuid().ToString();
            service.Update(patch);
            RuleDrafts.RemoveUnusedModels(service, models);
        }
    }
}
