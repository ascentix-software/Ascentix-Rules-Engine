using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Core.Publication
{
    // Configuration comes exclusively from one revision. Metadata and business data stay live.
    public sealed class SnapshotService : IOrganizationService
    {
        private readonly IOrganizationService live;
        private readonly List<Entity> rows;
        public SnapshotService(IOrganizationService live, RuleSnapshot snapshot)
        { this.live = live; rows = snapshot.Rows.Select(r => r.ToSdk()).ToList(); }
        internal SnapshotService(IOrganizationService live, IEnumerable<Entity> configuration)
        { this.live = live; rows = configuration.ToList(); }
        public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet)
        {
            if (!PublicationSchema.IsConfig(entityName)) return live.Retrieve(entityName, id, columnSet);
            var row = rows.SingleOrDefault(r => r.LogicalName == entityName && r.Id == id);
            if (row == null) throw new InvalidPluginExecutionException("Published configuration record is missing: " + id);
            return Copy(row);
        }
        public EntityCollection RetrieveMultiple(QueryBase query)
        {
            if (!(query is QueryExpression q) || !PublicationSchema.IsConfig(q.EntityName)) return live.RetrieveMultiple(query);
            if (q.LinkEntities.Count != 0) throw new InvalidPluginExecutionException("Unsupported published configuration query.");
            var found = rows.Where(r => r.LogicalName == q.EntityName && Matches(r, q.Criteria));
            if (q.TopCount.HasValue) found = found.Take(q.TopCount.Value);
            return new EntityCollection(found.Select(Copy).ToList());
        }
        private static Entity Copy(Entity source)
        { var e = new Entity(source.LogicalName, source.Id); foreach (var a in source.Attributes) e[a.Key] = a.Value; return e; }
        private static object Scalar(object v) => v is EntityReference r ? r.Id : v is OptionSetValue o ? o.Value : v;
        private static bool Equal(object a, object b) => Equals(Scalar(a), Scalar(b));
        private static bool Matches(Entity row, FilterExpression filter)
        {
            var results = filter.Conditions.Select(c => {
                object value = c.AttributeName == row.LogicalName + "id" ? row.Id : row.Attributes.TryGetValue(c.AttributeName, out var v) ? v : null;
                switch (c.Operator)
                {
                    case ConditionOperator.Equal: return Equal(value, c.Values[0]);
                    case ConditionOperator.NotEqual: return !Equal(value, c.Values[0]);
                    case ConditionOperator.In: return c.Values.Any(v => Equal(value, v));
                    case ConditionOperator.Null: return value == null;
                    case ConditionOperator.NotNull: return value != null;
                    default: throw new InvalidPluginExecutionException("Unsupported published configuration operator: " + c.Operator);
                }
            }).Concat(filter.Filters.Select(f => Matches(row, f))).ToList();
            return filter.FilterOperator == LogicalOperator.And ? results.All(x => x) : results.Any(x => x);
        }
        public OrganizationResponse Execute(OrganizationRequest request) => live.Execute(request);
        public Guid Create(Entity entity) => throw new InvalidPluginExecutionException("Published revisions are immutable.");
        public void Update(Entity entity) => throw new InvalidPluginExecutionException("Published revisions are immutable.");
        public void Delete(string entityName, Guid id) => throw new InvalidPluginExecutionException("Published revisions are immutable.");
        public void Associate(string entityName, Guid id, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
        public void Disassociate(string entityName, Guid id, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
    }

    public static class PublishedRules
    {
        public static RuleSnapshot Read(IOrganizationService service, Entity header)
        {
            var pointer = header.GetAttributeValue<EntityReference>(PublicationSchema.Pointer);
            if (pointer == null) return null;
            var revision = service.Retrieve(PublicationSchema.Revision, pointer.Id, new ColumnSet("asx_rule", "asx_definition", "asx_hash"));
            var snapshot = RuleSnapshot.Parse(revision.GetAttributeValue<string>("asx_definition"), header.Id);
            return snapshot;
        }
        public static List<Entity> Headers(IOrganizationService service, string table)
        {
            var q = new QueryExpression("asx_rule") { ColumnSet = new ColumnSet(true) };
            q.Criteria.AddCondition("asx_tablelogicalname", ConditionOperator.Equal, table);
            q.Criteria.AddCondition("statuscode", ConditionOperator.Equal, 753840000);
            return RuleSnapshot.QueryAll(service, q);
        }
    }
}
