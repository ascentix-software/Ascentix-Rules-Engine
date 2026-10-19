using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;
using Ascentix.RulesEngine.Plugin.DataUpdates;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin.Publication
{
    /// <summary>
    /// Publishes a saved rule: runs the data-update gate, validates the saved graph and stores a new
    /// immutable revision. Shared by the publish plug-in and rule import.
    /// </summary>
    public static class RulePublication
    {
        /// <summary>
        /// <paramref name="target"/> is an asx_rule entity carrying statuscode Published and its id. It is mutated the way
        /// the publish plug-in's Target is (pointer, number and hash on a header publish; statuscode Draft and base
        /// version on a draft publish). Returns the stored asx_rulerevision.
        /// </summary>
        public static Entity Publish(IPluginExecutionContext context, IOrganizationService service, Entity target, IReadOnlyList<IDataUpdate> updates)
        {
            // A pending data update must convert existing rules before any rule is published (docs/Schema.md §5.1).
            // A publish made by asx_ApplyDataUpdates itself (an update republishing the rules it converted)
            // is the update's own work, so it is not gated.
            if (!PluginReentry.IsInsideMessage(context, SchemaNames.Qualify(SchemaNames.ApplyDataUpdatesApi.MessageName)))
            {
                var pendingUpdate = DataUpdateGate.FirstPending(service, updates);
                if (pendingUpdate != null)
                    throw new InvalidPluginExecutionException(DataUpdateGate.PublishRefusal(pendingUpdate.Number));
            }

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
            Validate(service, snapshot, target.Id);

            var source = header.GetAttributeValue<EntityReference>(PublicationSchema.DraftOf);
            Entity revision = null;
            if (source != null)
            {
                var active = service.Retrieve("asx_rule", source.Id, new ColumnSet(true));
                var next = checked(active.GetAttributeValue<int>(PublicationSchema.Number) + 1);
                var published = RuleDrafts.Reidentify(snapshot, active.Id);
                PublicationCoordinator.Internal(context, service, writer => revision = PublicationCoordinator.Store(writer, published, next, context.InitiatingUserId));
                PublicationCoordinator.Internal(context, service, writer => writer.Update(new Entity("asx_rule", active.Id) {
                    [PublicationSchema.Pointer] = revision.ToEntityReference(), [PublicationSchema.Number] = next,
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published), ["asx_name"] = header.GetAttributeValue<string>("asx_name")
                }), reconcile: true);
                target["statuscode"] = new OptionSetValue(1);
                target[PublicationSchema.DraftBaseVersion] = next;
                target[PublicationSchema.PublishHash] = null;
                return revision;
            }
            var version = checked(header.GetAttributeValue<int>(PublicationSchema.Number) + 1);
            PublicationCoordinator.Internal(context, service, writer => {
                revision = PublicationCoordinator.Store(writer, snapshot, version, context.InitiatingUserId);
                target[PublicationSchema.Pointer] = revision.ToEntityReference();
                target[PublicationSchema.Number] = version;
                target[PublicationSchema.PublishHash] = null;
            });
            return revision;
        }

        /// <summary>Validates a rule definition against this environment's metadata; throws with the validator's errors.</summary>
        public static void Validate(IOrganizationService service, RuleSnapshot snapshot, Guid ruleId)
        {
            var model = RuleValidationLoader.Load(new SnapshotService(service, snapshot), ruleId);
            var report = RuleValidator.Validate(model, new AttributeFlagsProvider(service));
            if (!report.IsValid)
                throw new InvalidPluginExecutionException(
                    "This rule can't be published until these problems are fixed:\n" +
                    ValidationReportSerializer.JoinErrors(report));
        }
    }
}
