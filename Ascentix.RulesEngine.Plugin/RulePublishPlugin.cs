using System;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin.Publication;
using Microsoft.Xrm.Sdk.Query;

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

            var header = service.Retrieve("asx_rule", target.Id, new ColumnSet(true));
            if (header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf) == null &&
                (header.GetAttributeValue<EntityReference>(PublicationSchema.Pointer) != null || RuleDrafts.Find(service, header.Id) != null))
                throw new InvalidPluginExecutionException("Publish this rule's working draft in the Rule Builder so its latest changes are used.");
            // Publish only a previously saved graph; status and the expected hash are commands.
            // Other authored attributes in the same PATCH would not yet be committed.
            foreach (var field in target.Attributes.Keys)
                if (field.StartsWith("asx_", StringComparison.Ordinal) && field != PublicationSchema.PublishHash &&
                    field != PublicationSchema.DraftStamp && field != "asx_ruleid")
                    throw new InvalidPluginExecutionException("Save draft changes before publishing: " + field + ".");
            var snapshot = RuleSnapshot.Capture(service, target.Id);
            var model = RuleValidationLoader.Load(new SnapshotService(service, snapshot), target.Id);

            var report = RuleValidator.Validate(model, new AttributeFlagsProvider(service));
            if (!report.IsValid)
                throw new InvalidPluginExecutionException(
                    "This rule can't be published until these problems are fixed:\n" +
                    ValidationReportSerializer.JoinErrors(report));

            var source = header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf);
            if (source != null)
            {
                var active = service.Retrieve("asx_rule", source.Id, new ColumnSet(true));
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
