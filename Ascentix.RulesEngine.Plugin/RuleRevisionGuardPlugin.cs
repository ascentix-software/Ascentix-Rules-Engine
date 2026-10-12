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
    // Rule Delete captures ownership in PreValidation and cleans up in its transaction.
    public sealed class RuleRevisionGuardPlugin : PluginBase
    {
        public RuleRevisionGuardPlugin() : base(typeof(RuleRevisionGuardPlugin)) { }
        protected override void ExecuteCdsPlugin(ILocalPluginContext local)
        {
            var context = local.PluginExecutionContext;
            if (RuleDrafts.IsDeletingConfiguration(context)) return;
            if (context.MessageName == "Delete" && context.PrimaryEntityName == "asx_rule")
            {
                RuleDrafts.NativeDelete(local.SystemUserService, context);
                return;
            }
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
            if (!PublicationSchema.IsConfig(context.PrimaryEntityName)) return;
            if (context.MessageName == "SetState")
                throw new InvalidPluginExecutionException("Use a rule Update to change publication status so revision validation can run.");
            var target = context.InputParameters.TryGetValue("Target", out var input) ? input as Entity : null;
            if (context.PrimaryEntityName == "asx_rule" && context.MessageName == "Create" &&
                target?.GetAttributeValue<OptionSetValue>("statuscode")?.Value == 753840000)
                throw new InvalidPluginExecutionException("Create and save a draft before publishing it.");
            var service = local.SystemUserService;
            Entity before = null;
            var id = target?.Id ?? (input as EntityReference)?.Id ?? Guid.Empty;
            if (context.MessageName == "Delete")
            {
                context.PreEntityImages?.TryGetValue("PreImage", out before);
                if (before == null)
                {
                    var query = new QueryExpression(context.PrimaryEntityName) { ColumnSet = new ColumnSet(true), TopCount = 1 };
                    query.Criteria.AddCondition(context.PrimaryEntityName + "id", ConditionOperator.Equal, id);
                    before = service.RetrieveMultiple(query).Entities.SingleOrDefault();
                    if (before == null) return;
                }
                local.TracingService.Trace("Deleting {0} {1}: loaded configuration.", context.PrimaryEntityName, id);
            }
            else if (context.MessageName != "Create") before = service.Retrieve(context.PrimaryEntityName, id, new ColumnSet(true));
            if (context.PrimaryEntityName == "asx_rule")
            {
                if (before?.GetAttributeValue<EntityReference>(PublicationSchema.Pointer) != null &&
                    before.GetAttributeValue<OptionSetValue>("statuscode")?.Value == 753840000 &&
                    target?.GetAttributeValue<OptionSetValue>("statuscode")?.Value == 1)
                    RuleDrafts.Open(service, context, before);
                if (before != null && target != null &&
                    target.Attributes.Keys.Any(field => field.StartsWith("asx_", StringComparison.Ordinal) && field != PublicationSchema.PublishHash && !PublicationSchema.IsProtected(field) && field != "asx_ruleid") &&
                    RuleDrafts.RequiresWorkingDraft(service, before))
                    throw new InvalidPluginExecutionException("Edit this rule's working draft in the Rule Builder.");
                if (target != null && before != null && target.Contains("asx_tablelogicalname") &&
                    target.GetAttributeValue<string>("asx_tablelogicalname") != before.GetAttributeValue<string>("asx_tablelogicalname"))
                    throw new InvalidPluginExecutionException("A rule's business table cannot be changed. Create a rule for the other table.");
                return;
            }
            var owners = new HashSet<Guid>();
            FindOwners(service, before, owners, new HashSet<Guid>());
            FindOwners(service, target, owners, new HashSet<Guid>());
            foreach (var owner in owners)
                if (RuleDrafts.RequiresWorkingDraft(service, service.Retrieve("asx_rule", owner,
                    new ColumnSet("statuscode", PublicationSchema.Pointer, PublicationSchema.DraftOf))))
                    throw new InvalidPluginExecutionException("Edit this rule's working draft in the Rule Builder.");
            if (owners.Count == 0)
            {
                var changed = new List<Guid> { id };
                foreach (var row in new[] { before, target }.Where(row => row != null))
                    changed.AddRange(row.Attributes.Values.OfType<EntityReference>().Select(reference => reference.Id));
                PublicationCoordinator.PreserveSharedConfiguration(service, context, changed);
            }
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
