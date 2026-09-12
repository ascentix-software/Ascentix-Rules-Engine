using System;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Crm.Sdk.Messages;
using Ascentix.RulesEngine.Core.Publication;

namespace Ascentix.RulesEngine.Plugin.Publication
{
    public static class PublicationCoordinator
    {
        private const string Marker = "Ascentix.InternalRevisionWrite";
        public static bool IsInternal(IPluginExecutionContext context, IOrganizationService service)
        {
            if (!context.IsInTransaction || context.Mode != 0) return false;
            for (var parent = context.ParentContext; parent != null; parent = parent.ParentContext)
                if (parent.IsInTransaction && parent.CorrelationId == context.CorrelationId &&
                    parent.SharedVariables != null && parent.SharedVariables.TryGetValue(Marker, out var value) && value is Guid id && id == parent.CorrelationId)
                    return true;
            // SDK operations can omit mutable SharedVariables from their parent frames.
            // A request tag also binds the write to its registered transactional ancestor.
            string tag = null;
            for (var frame = context; frame != null && tag == null && frame.CorrelationId == context.CorrelationId; frame = frame.ParentContext)
                if (frame.SharedVariables != null && frame.SharedVariables.TryGetValue("tag", out var rawTag)) tag = rawTag as string;
            var target = context.InputParameters.TryGetValue("Target", out var rawTarget)
                ? (rawTarget as Entity)?.ToEntityReference() ?? rawTarget as EntityReference : null;
            if (tag == null || target == null || context.UserId == Guid.Empty) return false;
            for (var parent = context.ParentContext; parent != null; parent = parent.ParentContext)
            {
                if (!parent.IsInTransaction || parent.Mode != 0 || parent.CorrelationId != context.CorrelationId ||
                    tag != WriteTag(parent, context.MessageName, target, context.UserId)) continue;
                if (IsRevisionApi(parent))
                {
                    if (RegisteredRevisionApi(service, parent.MessageName)) return true;
                    continue;
                }
                var extension = parent.OwningExtension;
                if (extension == null) continue;
                EntityReference handler = null;
                if (extension.LogicalName == "sdkmessageprocessingstep")
                    handler = service.Retrieve(extension.LogicalName, extension.Id, new ColumnSet("eventhandler"))
                        .GetAttributeValue<EntityReference>("eventhandler");
                else if (extension.LogicalName == "customapi")
                    handler = service.Retrieve(extension.LogicalName, extension.Id, new ColumnSet("plugintypeid"))
                        .GetAttributeValue<EntityReference>("plugintypeid");
                if (handler?.LogicalName != "plugintype") continue;
                var type = service.Retrieve("plugintype", handler.Id, new ColumnSet("typename")).GetAttributeValue<string>("typename");
                if (parent.Stage == 20 && parent.MessageName == "Update" && parent.PrimaryEntityName == "asx_rule" &&
                    type == typeof(RulePublishPlugin).FullName) return true;
                if (parent.Stage == 20 && new[] { "Create", "Update", "Delete" }.Contains(parent.MessageName) &&
                    PublicationSchema.IsConfig(parent.PrimaryEntityName) && type == typeof(RuleRevisionGuardPlugin).FullName) return true;
            }
            return false;
        }

        public static string WriteTag(IPluginExecutionContext owner, string message, EntityReference target, Guid executor)
        {
            // Global Custom API parent frames can omit the executing extension and normalize
            // the empty primary entity. Resolve their main handler from API registration instead.
            var api = IsRevisionApi(owner);
            var identity = api
                ? owner.CorrelationId + ":" + owner.MessageName + ":" + owner.InitiatingUserId + ":" +
                    executor + ":" + message + ":" + target.LogicalName + ":" + target.Id
                : owner.CorrelationId + ":" + owner.OwningExtension?.Id + ":" +
                owner.MessageName + ":" + owner.PrimaryEntityName + ":" + owner.PrimaryEntityId + ":" +
                owner.InitiatingUserId + ":" + executor + ":" + message + ":" + target.LogicalName + ":" + target.Id;
            using (var hash = SHA256.Create())
                return (api ? "Ascentix.RuleRevisionApiWrite.v2:" : "Ascentix.RuleRevisionWrite.v2:") +
                    BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "");
        }

        private static bool IsRevisionApi(IPluginExecutionContext context) => context.Stage == 30 &&
            (context.MessageName == "asx_RestoreRuleDraft" || context.MessageName == "asx_InitializeRuleRevisions");

        private static bool RegisteredRevisionApi(IOrganizationService service, string message)
        {
            var query = new QueryExpression("customapi") { TopCount = 2,
                ColumnSet = new ColumnSet("plugintypeid", "bindingtype", "isfunction", "allowedcustomprocessingsteptype") };
            query.Criteria.AddCondition("uniquename", ConditionOperator.Equal, message);
            var registrations = service.RetrieveMultiple(query).Entities;
            if (registrations.Count != 1) return false;
            var api = registrations[0];
            if (api.GetAttributeValue<OptionSetValue>("bindingtype")?.Value != 0 ||
                !api.Contains("isfunction") || api.GetAttributeValue<bool>("isfunction") ||
                api.GetAttributeValue<OptionSetValue>("allowedcustomprocessingsteptype")?.Value != 0) return false;
            var handler = api.GetAttributeValue<EntityReference>("plugintypeid");
            return handler?.LogicalName == "plugintype" &&
                service.Retrieve("plugintype", handler.Id, new ColumnSet("typename")).GetAttributeValue<string>("typename") == typeof(RuleRevisionApi).FullName;
        }

        public static void Internal(IPluginExecutionContext context, IOrganizationService service, Action<IOrganizationService> action)
        {
            var hadPrevious = context.SharedVariables.TryGetValue(Marker, out var previous);
            context.SharedVariables[Marker] = context.CorrelationId;
            try { action(new InternalWriter(service, context)); }
            finally
            {
                if (hadPrevious) context.SharedVariables[Marker] = previous;
                else context.SharedVariables.Remove(Marker);
            }
        }
        public static void Lock(IOrganizationService service, IPluginExecutionContext context)
        {
            if (!context.IsInTransaction) throw new InvalidPluginExecutionException("Revision changes require a synchronous database transaction.");
            service.Execute(new UpsertRequest { Target = new Entity(PublicationSchema.Lock, PublicationSchema.LockId) {
                ["asx_name"] = Guid.NewGuid().ToString() } });
        }
        public static Entity Store(IOrganizationService service, RuleSnapshot snapshot, int version, Guid publisher)
        {
            var json = snapshot.Serialize();
            if (json.Length > 1000000) throw new InvalidPluginExecutionException("Published rule exceeds the 1,000,000 character revision limit.");
            var revision = new Entity(PublicationSchema.Revision, Guid.NewGuid()) {
                ["asx_name"] = snapshot.RuleId + " v" + version,
                ["asx_rule"] = new EntityReference("asx_rule", snapshot.RuleId),
                ["asx_version"] = version, ["asx_definition"] = json, ["asx_hash"] = snapshot.Hash(),
                ["asx_publisher"] = new EntityReference("systemuser", publisher), ["asx_publishedon"] = DateTime.UtcNow };
            service.Create(revision);
            return revision;
        }

        // Capture old behavior before ANY authoring write can change a legacy dependency.
        // The deployment backfill invokes this in bounded batches before authors resume work.
        public static void Bootstrap(IOrganizationService service, IPluginExecutionContext context, int limit = 0)
        {
            var query = new QueryExpression("asx_rule") { ColumnSet = new ColumnSet(true) };
            query.Criteria.AddCondition("statuscode", ConditionOperator.Equal, 753840000);
            query.Criteria.AddCondition(PublicationSchema.Pointer, ConditionOperator.Null);
            var rules = RuleSnapshot.QueryAll(service, query);
            if (limit == 0 && rules.Count > 20)
                throw new InvalidPluginExecutionException("Published revisions must be initialized before editing. Run the revision backfill deployment step; enforcement remains active.");
            foreach (var rule in limit > 0 ? rules.Take(limit) : rules)
            {
                var snapshot = RuleSnapshot.Capture(service, rule.Id);
                Internal(context, service, writer => {
                    var revision = Store(writer, snapshot, 1, context.InitiatingUserId);
                    writer.Update(new Entity("asx_rule", rule.Id) {
                        [PublicationSchema.Pointer] = revision.ToEntityReference(), [PublicationSchema.Number] = 1 });
                });
            }
        }

        private sealed class InternalWriter : IOrganizationService
        {
            private readonly IOrganizationService service;
            private readonly IPluginExecutionContext owner;
            private Guid? executor;
            public InternalWriter(IOrganizationService service, IPluginExecutionContext owner)
            { this.service = service; this.owner = owner; }
            private OrganizationResponse Send(OrganizationRequest request, EntityReference target)
            {
                // System-service child pipelines can report a different initiating user.
                // Bind authorization to the identity of the service that actually sends the write.
                if (!executor.HasValue) executor = ((WhoAmIResponse)service.Execute(new WhoAmIRequest())).UserId;
                request["tag"] = WriteTag(owner, request.RequestName, target, executor.Value);
                return service.Execute(request);
            }
            public Guid Create(Entity entity) => ((CreateResponse)Send(new CreateRequest { Target = entity }, entity.ToEntityReference())).id;
            public void Update(Entity entity) => Send(new UpdateRequest { Target = entity }, entity.ToEntityReference());
            public void Delete(string entityName, Guid id)
            {
                var target = new EntityReference(entityName, id);
                Send(new DeleteRequest { Target = target }, target);
            }
            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => service.Retrieve(entityName, id, columnSet);
            public EntityCollection RetrieveMultiple(QueryBase query) => service.RetrieveMultiple(query);
            public OrganizationResponse Execute(OrganizationRequest request) => service.Execute(request);
            public void Associate(string entityName, Guid id, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
            public void Disassociate(string entityName, Guid id, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
        }
    }
}
