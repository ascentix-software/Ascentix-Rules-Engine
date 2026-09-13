using System;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin.Publication;
using Microsoft.Xrm.Sdk.Query;
using Microsoft.Crm.Sdk.Messages;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Pre-operation publication on asx_rule Update. Each explicit Published status write
    /// validates the saved draft and prepares a new immutable revision in the same transaction.
    /// </summary>
    public class RulePublishPlugin : PluginBase
    {
        public RulePublishPlugin() : base(typeof(RulePublishPlugin)) { }

        protected override void ExecuteCdsPlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null) throw new ArgumentNullException(nameof(localPluginContext));

            var context = localPluginContext.PluginExecutionContext;
            var service = localPluginContext.SystemUserService;

            if (!context.InputParameters.TryGetValue("Target", out var t) || !(t is Entity target)) return;

            if (target.GetAttributeValue<OptionSetValue>("statuscode")?.Value != (int)RuleStatus.Published) return;

            PublicationCoordinator.Lock(service, context);
            // Publish only a previously saved graph; status and the expected hash are commands.
            // Other authored attributes in the same PATCH would not yet be committed.
            foreach (var field in target.Attributes.Keys)
                if (field.StartsWith("asx_", StringComparison.Ordinal) && field != PublicationSchema.PublishHash &&
                    field != PublicationSchema.DraftStamp && field != "asx_ruleid")
                    throw new InvalidPluginExecutionException("Save draft changes before publishing: " + field + ".");
            var snapshot = RuleSnapshot.Capture(service, target.Id);
            var expected = target.GetAttributeValue<string>(PublicationSchema.PublishHash);
            if (!string.IsNullOrEmpty(expected) && expected != snapshot.Hash())
                throw new InvalidPluginExecutionException("The draft or its shared data model changed after validation. Reload and validate again; the published version is unchanged.");
            var model = RuleValidationLoader.Load(new SnapshotService(service, snapshot), target.Id);

            var report = RuleValidator.Validate(model, new AttributeFlagsProvider(service));
            if (!report.IsValid)
                throw new InvalidPluginExecutionException(
                    "This rule can't be published until these problems are fixed:\n" +
                    ValidationReportSerializer.JoinErrors(report));

            // SEC gate (publisher-relative, fail-closed): a System-context rule with write actions
            // may only be published by a user holding the matching privilege at Global depth on
            // each target table. Otherwise an Author with config-table CRUD alone could delegate
            // org-wide writes to SYSTEM. InitiatingUserId: the human behind the publish, so an
            // impersonated publish can't launder the check.
            var secIssues = SecurityChecks.Check(
                model, new PublisherPrivilegeProvider(service, context.InitiatingUserId));
            var secReport = ValidationReport.From(secIssues);
            if (!secReport.IsValid)
                throw new InvalidPluginExecutionException(
                    "This rule can't be published until these problems are fixed:\n" +
                    ValidationReportSerializer.JoinErrors(secReport));
            var header = service.Retrieve("asx_rule", target.Id, new ColumnSet(true));
            var source = header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf);
            if (source != null)
            {
                var access = (RetrievePrincipalAccessResponse)service.Execute(new RetrievePrincipalAccessRequest {
                    Principal = new EntityReference("systemuser", context.InitiatingUserId), Target = source });
                if ((access.AccessRights & AccessRights.WriteAccess) == 0)
                    throw new InvalidPluginExecutionException("You do not have permission to publish this rule.");
                var active = service.Retrieve("asx_rule", source.Id, new ColumnSet(true));
                if (header.GetAttributeValue<int>(PublicationSchema.DraftBaseVersion) != active.GetAttributeValue<int>(PublicationSchema.Number))
                    throw new InvalidPluginExecutionException("The published rule changed. Reload its draft before publishing.");
                var next = checked(active.GetAttributeValue<int>(PublicationSchema.Number) + 1);
                var published = RuleDrafts.Reidentify(snapshot, active.Id);
                Entity revision = null;
                PublicationCoordinator.Internal(context, service, writer => revision = PublicationCoordinator.Store(writer, published, next, context.InitiatingUserId));
                PublicationCoordinator.Internal(context, service, writer => writer.Update(new Entity("asx_rule", active.Id) {
                    [PublicationSchema.Pointer] = revision.ToEntityReference(), [PublicationSchema.Number] = next,
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published), ["asx_name"] = header.GetAttributeValue<string>("asx_name")
                }), reconcile: true);
                target["statuscode"] = new OptionSetValue(1);
                target[PublicationSchema.DraftBaseVersion] = next;
                target[PublicationSchema.PublishHash] = null;
                return;
            }
            var version = checked(header.GetAttributeValue<int>(PublicationSchema.Number) + 1);
            PublicationCoordinator.Internal(context, service, writer => {
                var revision = PublicationCoordinator.Store(writer, snapshot, version, context.InitiatingUserId);
                target[PublicationSchema.Pointer] = revision.ToEntityReference();
                target[PublicationSchema.Number] = version;
                target[PublicationSchema.PublishHash] = null;
            });
        }
    }
}
