using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Minimal IOrganizationService double: counts Retrieve / RetrieveMultiple calls,
    /// captures each RetrieveMultiple's FetchXml, and returns queued EntityCollections
    /// (in order) so tests can assert call counts, batching, and paging accumulation.
    /// </summary>
    internal sealed class RecordingFakeService : IOrganizationService
    {
        public int RetrieveCount;
        public int RetrieveMultipleCount;
        public readonly List<string> CapturedFetchXml = new List<string>();
        private readonly Queue<EntityCollection> _responses;

        public RecordingFakeService(IEnumerable<EntityCollection> responses)
        {
            _responses = new Queue<EntityCollection>(responses);
        }

        public EntityCollection RetrieveMultiple(QueryBase query)
        {
            RetrieveMultipleCount++;
            if (query is FetchExpression fe) CapturedFetchXml.Add(fe.Query);
            return _responses.Count > 0 ? _responses.Dequeue() : new EntityCollection();
        }

        public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet)
        {
            RetrieveCount++;
            return new Entity(entityName, id);
        }

        public Guid Create(Entity entity) => throw new NotImplementedException();
        public void Update(Entity entity) => throw new NotImplementedException();
        public void Delete(string entityName, Guid id) => throw new NotImplementedException();
        public OrganizationResponse Execute(OrganizationRequest request) => throw new NotImplementedException();
        public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotImplementedException();
        public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotImplementedException();
    }

    internal static class FakePages
    {
        /// <summary>Build an EntityCollection page with the given entities + paging flags.</summary>
        public static EntityCollection Page(string logicalName, int count, bool moreRecords, string cookie = "<cookie/>")
        {
            var ec = new EntityCollection { EntityName = logicalName, MoreRecords = moreRecords };
            if (moreRecords) ec.PagingCookie = cookie;
            for (var i = 0; i < count; i++)
                ec.Entities.Add(new Entity(logicalName, Guid.NewGuid()));
            return ec;
        }
    }
}
