using System;
using System.Linq;
using FakeItEasy;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// A calling user's service that can't read one row: RetrieveMultiple never returns it, as if
    /// the row were outside the user's security scope. Everything else passes straight through.
    /// </summary>
    internal sealed class HiddenRowService : IOrganizationService
    {
        private readonly IOrganizationService _inner;
        private readonly Guid _hidden;

        public HiddenRowService(IOrganizationService inner, Guid hidden)
        {
            _inner = inner;
            _hidden = hidden;
        }

        public EntityCollection RetrieveMultiple(QueryBase query)
        {
            var result = _inner.RetrieveMultiple(query);
            var visible = result.Entities.Where(e => e.Id != _hidden).ToList();
            if (visible.Count == result.Entities.Count) return result;
            var filtered = new EntityCollection(visible)
            {
                EntityName = result.EntityName,
                MoreRecords = result.MoreRecords,
                PagingCookie = result.PagingCookie,
            };
            return filtered;
        }

        public Guid Create(Entity entity) => _inner.Create(entity);
        public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => _inner.Retrieve(entityName, id, columnSet);
        public void Update(Entity entity) => _inner.Update(entity);
        public void Delete(string entityName, Guid id) => _inner.Delete(entityName, id);
        public OrganizationResponse Execute(OrganizationRequest request) => _inner.Execute(request);
        public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities)
            => _inner.Associate(entityName, entityId, relationship, relatedEntities);
        public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities)
            => _inner.Disassociate(entityName, entityId, relationship, relatedEntities);
    }

    /// <summary>A faked context that can run a plug-in with its CurrentUserService replaced (the
    /// SystemUserService stays the context's own service).</summary>
    public class CallerServiceContext : XrmFakedContext
    {
        public void ExecuteAs<T>(XrmFakedPluginExecutionContext pctx, IOrganizationService user) where T : IPlugin, new()
        {
            var provider = GetFakedServiceProvider(pctx);
            var system = GetOrganizationService();
            var factory = A.Fake<IOrganizationServiceFactory>();
            A.CallTo(() => factory.CreateOrganizationService(A<Guid?>._))
                .ReturnsLazily((Guid? userId) => userId.HasValue ? user : system);
            A.CallTo(() => provider.GetService(typeof(IOrganizationServiceFactory))).Returns(factory);
            new T().Execute(provider);
        }
    }
}
