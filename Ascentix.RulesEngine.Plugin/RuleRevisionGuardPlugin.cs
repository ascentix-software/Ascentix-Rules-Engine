using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin.Publication;

namespace Ascentix.RulesEngine.Plugin
{
    // Pre-operation, order 1, on all configuration Create/Update/Delete operations.
    public sealed class RuleRevisionGuardPlugin : PluginBase
    {
        public RuleRevisionGuardPlugin() : base(typeof(RuleRevisionGuardPlugin)) { }
        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            var context = local.PluginExecutionContext;
            if (PublicationCoordinator.IsInternal(context, local.SystemUserService)) return;
            if (context.MessageName == "Associate" || context.MessageName == "Disassociate")
            {
                var relationshipTarget = context.InputParameters.TryGetValue("Target", out var relationshipInput) ? relationshipInput as EntityReference : null;
                var related = context.InputParameters.TryGetValue("RelatedEntities", out var relatedInput) ? relatedInput as EntityReferenceCollection : null;
                bool IsConfiguration(EntityReference reference) => reference != null &&
                    (PublicationSchema.IsConfig(reference.LogicalName) || reference.LogicalName == PublicationSchema.Revision);
                if (IsConfiguration(relationshipTarget) || (related?.Any(IsConfiguration) ?? false))
                    throw new InvalidPluginExecutionException("Use record Update to change rule configuration relationships so draft and publication guards can run.");
                return;
            }
            if (context.PrimaryEntityName == PublicationSchema.Revision)
                throw new InvalidPluginExecutionException("Published revisions are immutable and can only be created by publishing a rule.");
            if (!PublicationSchema.IsConfig(context.PrimaryEntityName)) return;
            if (context.MessageName == "SetState")
                throw new InvalidPluginExecutionException("Use a rule Update to change publication status so revision validation can run.");
            var target = context.InputParameters.TryGetValue("Target", out var input) ? input as Entity : null;
            if (context.PrimaryEntityName == "asx_rule" && context.MessageName == "Create" &&
                target?.GetAttributeValue<OptionSetValue>("statuscode")?.Value == 753840000)
                throw new InvalidPluginExecutionException("Create and save a draft before publishing it.");
            if (target != null && target.LogicalName == "asx_rule" && target.Attributes.Keys.Any(PublicationSchema.IsProtected))
                throw new InvalidPluginExecutionException("Published revision metadata is managed by the server.");
            var service = local.SystemUserService;
            PublicationCoordinator.Lock(service, context);
            PublicationCoordinator.Bootstrap(service, context);
            Entity before = null;
            var id = target?.Id ?? (input as EntityReference)?.Id ?? Guid.Empty;
            if (context.MessageName != "Create") before = service.Retrieve(context.PrimaryEntityName, id, new ColumnSet(true));
            if (context.PrimaryEntityName == "asx_rule")
            {
                if (target != null && before != null && target.Contains("asx_tablelogicalname") &&
                    target.GetAttributeValue<string>("asx_tablelogicalname") != before.GetAttributeValue<string>("asx_tablelogicalname"))
                    throw new InvalidPluginExecutionException("A rule's business table cannot be changed. Create a rule for the other table.");
                if (context.MessageName == "Delete") PublicationCoordinator.Internal(context, service, writer => {
                    writer.Update(new Entity("asx_rule", id) { [PublicationSchema.Pointer] = null });
                    var query = new QueryExpression(PublicationSchema.Revision) { ColumnSet = new ColumnSet(false) };
                    query.Criteria.AddCondition("asx_rule", ConditionOperator.Equal, id);
                    foreach (var revision in RuleSnapshot.QueryAll(service, query)) writer.Delete(PublicationSchema.Revision, revision.Id);
                });
                if (target != null) target[PublicationSchema.DraftStamp] = Guid.NewGuid().ToString();
                return;
            }
            var owners = new HashSet<Guid>();
            FindOwners(service, before, owners, new HashSet<Guid>());
            FindOwners(service, target, owners, new HashSet<Guid>());
            PublicationCoordinator.Internal(context, service, writer => {
                foreach (var owner in owners)
                    writer.Update(new Entity("asx_rule", owner) { [PublicationSchema.DraftStamp] = Guid.NewGuid().ToString() });
            });
        }
        private static void FindOwners(IOrganizationService service, Entity row, HashSet<Guid> owners, HashSet<Guid> seen)
        {
            if (row == null || !seen.Add(row.Id)) return;
            foreach (var r in row.Attributes.Values.OfType<EntityReference>())
            {
                if (r.LogicalName == "asx_rule") owners.Add(r.Id);
                else if (PublicationSchema.IsConfig(r.LogicalName) && r.LogicalName != "asx_tableconfig")
                    FindOwners(service, service.Retrieve(r.LogicalName, r.Id, new ColumnSet(true)), owners, seen);
            }
        }
    }
}
