using System;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Microsoft.Xrm.Sdk.Messages;
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
            if (tag == null || target == null || !context.IsInTransaction || context.Mode != 0) return false;
            for (var parent = context.ParentContext; parent != null; parent = parent.ParentContext)
            {
                if (!parent.IsInTransaction || parent.Mode != 0 || parent.CorrelationId != context.CorrelationId ||
                    parent.InitiatingUserId != context.InitiatingUserId || parent.OwningExtension == null ||
                    tag != WriteTag(parent, context.MessageName, target)) continue;
                var extension = parent.OwningExtension;
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
                if (parent.Stage == 30 && (parent.MessageName == "asx_RestoreRuleDraft" || parent.MessageName == "asx_InitializeRuleRevisions") &&
                    type == typeof(RuleRevisionApi).FullName) return true;
            }
            return false;
        }

        public static string WriteTag(IPluginExecutionContext owner, string message, EntityReference target)
        {
            var identity = owner.CorrelationId + ":" + owner.OwningExtension?.Id + ":" +
                owner.MessageName + ":" + owner.PrimaryEntityName + ":" + owner.PrimaryEntityId + ":" +
                owner.InitiatingUserId + ":" + message + ":" + target.LogicalName + ":" + target.Id;
            using (var hash = SHA256.Create())
                return "Ascentix.RuleRevisionWrite.v1:" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "");
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
            public InternalWriter(IOrganizationService service, IPluginExecutionContext owner)
            { this.service = service; this.owner = owner; }
            private OrganizationResponse Send(OrganizationRequest request, EntityReference target)
            {
                request["tag"] = WriteTag(owner, request.RequestName, target);
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
