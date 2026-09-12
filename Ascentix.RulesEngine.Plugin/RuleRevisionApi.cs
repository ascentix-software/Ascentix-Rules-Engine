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
    // Main-operation handler for ReadPublishedRule, RestoreRuleDraft and InitializeRuleRevisions.
    public sealed class RuleRevisionApi : PluginBase
    {
        public RuleRevisionApi() : base(typeof(RuleRevisionApi)) { }
        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            var context = local.PluginExecutionContext;
            var service = local.SystemUserService;
            if (context.MessageName == "asx_InitializeRuleRevisions")
            {
                // The Custom API additionally requires prvWriteEntity (customizer/admin).
                PublicationCoordinator.Lock(service, context);
                PublicationCoordinator.Bootstrap(service, context, 10);
                var q = new QueryExpression("asx_rule") { ColumnSet = new ColumnSet(false) };
                q.Criteria.AddCondition("statuscode", ConditionOperator.Equal, 753840000);
                q.Criteria.AddCondition(PublicationSchema.Pointer, ConditionOperator.Null);
                context.OutputParameters["Remaining"] = RuleSnapshot.QueryAll(service, q).Count;
                return;
            }
            if (!context.InputParameters.TryGetValue("RuleId", out var raw) || !Guid.TryParse(raw as string, out var ruleId))
                throw new InvalidPluginExecutionException("RuleId is required.");
            var access = (RetrievePrincipalAccessResponse)service.Execute(new RetrievePrincipalAccessRequest {
                Principal = new EntityReference("systemuser", context.InitiatingUserId), Target = new EntityReference("asx_rule", ruleId) });
            if ((access.AccessRights & AccessRights.ReadAccess) == 0)
                throw new InvalidPluginExecutionException("You do not have permission to read this rule.");
            if (context.MessageName == "asx_RestoreRuleDraft")
            {
                if ((access.AccessRights & AccessRights.WriteAccess) == 0)
                    throw new InvalidPluginExecutionException("You do not have permission to edit this rule.");
                PublicationCoordinator.Lock(service, context);
            }
            var header = service.Retrieve("asx_rule", ruleId, new ColumnSet(true));
            var snapshot = PublishedRules.Read(service, header);
            if (snapshot == null) throw new InvalidPluginExecutionException("This rule has no published revision. Initialize existing revisions before using this operation.");
            if (context.MessageName == "asx_ReadPublishedRule")
            { context.OutputParameters["Definition"] = snapshot.Serialize(); return; }
            if (context.MessageName != "asx_RestoreRuleDraft") throw new InvalidPluginExecutionException("Unknown revision operation.");
            var expected = context.InputParameters.TryGetValue("ExpectedVersion", out var version) ? version as string : null;
            var current = header.RowVersion ?? Convert.ToString(header.GetAttributeValue<long>("versionnumber"));
            if (string.IsNullOrEmpty(expected) || expected != current)
                throw new InvalidPluginExecutionException("This rule changed elsewhere. Reload before discarding its draft.");
            PublicationCoordinator.Internal(context, service, writer => Restore(writer, header, snapshot));
        }

        public static void Restore(IOrganizationService service, Entity header, RuleSnapshot published)
        {
            var current = RuleSnapshot.Capture(service, header.Id, false);
            var pendingDeletes = current.Rows.Where(r => r.Entity != "asx_rule").Select(r => r.ToSdk()).ToList();
            while (pendingDeletes.Count > 0)
            {
                var leaves = pendingDeletes.Where(r => !pendingDeletes.Any(other => other.Id != r.Id &&
                    other.Attributes.Values.OfType<EntityReference>().Any(ref0 => ref0.Id == r.Id))).ToList();
                if (leaves.Count == 0) throw new InvalidPluginExecutionException("The draft contains an ownership cycle; repair it before restoring.");
                foreach (var row in leaves) { service.Delete(row.LogicalName, row.Id); pendingDeletes.Remove(row); }
            }
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
        }
    }
}
