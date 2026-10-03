using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>Wraps a service and counts RetrieveMultiple calls per queried table (FetchXML and
    /// QueryExpression), keeping each FetchXML query. Everything else passes straight through.</summary>
    internal sealed class CountingOrganizationService : IOrganizationService
    {
        private readonly IOrganizationService _inner;
        public readonly Dictionary<string, int> RetrieveMultipleByTable = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        public readonly List<string> FetchXml = new List<string>();

        public CountingOrganizationService(IOrganizationService inner) { _inner = inner; }

        public int Count(string table) => RetrieveMultipleByTable.TryGetValue(table, out var n) ? n : 0;

        public EntityCollection RetrieveMultiple(QueryBase query)
        {
            string table = null;
            if (query is QueryExpression qe) table = qe.EntityName;
            if (query is FetchExpression fe)
            {
                FetchXml.Add(fe.Query);
                var start = fe.Query.IndexOf("<entity name='", StringComparison.Ordinal);
                if (start >= 0)
                {
                    start += "<entity name='".Length;
                    table = fe.Query.Substring(start, fe.Query.IndexOf('\'', start) - start);
                }
            }
            if (table != null) RetrieveMultipleByTable[table] = Count(table) + 1;
            return _inner.RetrieveMultiple(query);
        }

        public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => _inner.Retrieve(entityName, id, columnSet);
        public Guid Create(Entity entity) => _inner.Create(entity);
        public void Update(Entity entity) => _inner.Update(entity);
        public void Delete(string entityName, Guid id) => _inner.Delete(entityName, id);
        public OrganizationResponse Execute(OrganizationRequest request) => _inner.Execute(request);
        public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => _inner.Associate(entityName, entityId, relationship, relatedEntities);
        public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => _inner.Disassociate(entityName, entityId, relationship, relatedEntities);
    }
}
