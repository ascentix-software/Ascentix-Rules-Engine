using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Ascentix.RulesEngine.Core.Publication;

namespace Ascentix.RulesEngine.Plugin.Publication
{
    public static class PublicationCoordinator
    {
        public static void Internal(IPluginExecutionContext context, IOrganizationService service, Action<IOrganizationService> action, bool reconcile = false)
        {
            if (!context.IsInTransaction || context.Mode != 0)
                throw new InvalidPluginExecutionException("Rule changes require a synchronous database transaction.");
            action(new InternalWriter(service, reconcile));
        }

        public static void Lock(IOrganizationService service, IPluginExecutionContext context)
        {
            if (!context.IsInTransaction) throw new InvalidPluginExecutionException("Rule changes require a synchronous database transaction.");
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

        // Preserve only existing live definitions that use the shared configuration being changed.
        public static void PreserveSharedConfiguration(IOrganizationService service, IPluginExecutionContext context, IEnumerable<Guid> changedIds)
        {
            var ids = new HashSet<Guid>(changedIds.Where(id => id != Guid.Empty));
            if (ids.Count == 0) return;
            // A rule referencing a descendant also depends on the changed ancestor.
            var nodes = RuleSnapshot.QueryAll(service, new QueryExpression("asx_tableconfig") {
                ColumnSet = new ColumnSet("asx_parenttable") });
            bool expanded;
            do {
                expanded = false;
                foreach (var node in nodes)
                    if (ids.Contains(node.GetAttributeValue<EntityReference>("asx_parenttable")?.Id ?? Guid.Empty))
                        expanded |= ids.Add(node.Id);
            } while (expanded);
            var query = new QueryExpression("asx_rule") { ColumnSet = new ColumnSet(true) };
            query.Criteria.AddCondition("statuscode", ConditionOperator.Equal, 753840000);
            query.Criteria.AddCondition(PublicationSchema.Pointer, ConditionOperator.Null);
            foreach (var rule in RuleSnapshot.QueryAll(service, query))
            {
                var authored = RuleSnapshot.Capture(service, rule.Id, includeConfigs: false);
                if (!authored.Rows.SelectMany(row => row.Attributes.Values).Any(value =>
                    (value.Kind == "reference" && Guid.TryParse(value.Value, out var reference) && ids.Contains(reference)) ||
                    (value.Kind == "string" && value.Value != null && ids.Any(id => value.Value.IndexOf(id.ToString(), StringComparison.OrdinalIgnoreCase) >= 0)))) continue;
                var snapshot = RuleSnapshot.Capture(service, rule.Id);
                Internal(context, service, writer => {
                    var revision = Store(writer, snapshot, rule.GetAttributeValue<int>(PublicationSchema.Number), context.InitiatingUserId);
                    writer.Update(new Entity("asx_rule", rule.Id) {
                        [PublicationSchema.Pointer] = revision.ToEntityReference() });
                });
            }
        }

        private sealed class InternalWriter : IOrganizationService
        {
            private readonly IOrganizationService service;
            private readonly bool reconcile;
            private readonly Dictionary<string, string> steps = new Dictionary<string, string>();
            public InternalWriter(IOrganizationService service, bool reconcile)
            { this.service = service; this.reconcile = reconcile; }

            private string StepIds(string message, string table)
            {
                var key = message + ":" + table;
                if (steps.TryGetValue(key, out var found)) return found;
                var metadata = (RetrieveEntityResponse)service.Execute(new RetrieveEntityRequest {
                    LogicalName = table, EntityFilters = EntityFilters.Entity });
                var objectTypeCode = metadata.EntityMetadata.ObjectTypeCode
                    ?? throw new InvalidPluginExecutionException("Rule configuration table metadata is incomplete.");
                var query = new QueryExpression("sdkmessageprocessingstep") { ColumnSet = new ColumnSet(false) };
                query.Criteria.AddCondition("statecode", ConditionOperator.Equal, 0);
                var type = query.AddLink("plugintype", "eventhandler", "plugintypeid");
                var names = new List<object> { typeof(RuleRevisionGuardPlugin).FullName, typeof(RulePublishPlugin).FullName };
                if (!reconcile) names.Add(typeof(RuleRegistrationPlugin).FullName);
                type.LinkCriteria.AddCondition("typename", ConditionOperator.In, names.ToArray());
                var assembly = type.AddLink("pluginassembly", "pluginassemblyid", "pluginassemblyid");
                var identity = typeof(PublicationCoordinator).Assembly.GetName();
                assembly.LinkCriteria.AddCondition("name", ConditionOperator.Equal, identity.Name);
                assembly.LinkCriteria.AddCondition("publickeytoken", ConditionOperator.Equal,
                    string.Concat(identity.GetPublicKeyToken().Select(b => b.ToString("x2"))));
                query.AddLink("sdkmessage", "sdkmessageid", "sdkmessageid").LinkCriteria.AddCondition("name", ConditionOperator.Equal, message);
                query.AddLink("sdkmessagefilter", "sdkmessagefilterid", "sdkmessagefilterid").LinkCriteria.AddCondition("primaryobjecttypecode", ConditionOperator.Equal, objectTypeCode);
                var matches = service.RetrieveMultiple(query).Entities;
                if (matches.Count > 3) throw new InvalidPluginExecutionException("Duplicate rule lifecycle registrations must be repaired.");
                found = string.Join(",", matches.Select(step => step.Id.ToString()));
                steps[key] = found;
                return found;
            }

            private OrganizationResponse Send(OrganizationRequest request, EntityReference target)
            {
                var ids = StepIds(request.RequestName, target.LogicalName);
                if (ids.Length > 0) request["BypassBusinessLogicExecutionStepIds"] = ids;
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
