using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;
using Microsoft.Xrm.Sdk.Query;

namespace Ascentix.RulesEngine.Tests
{
    public class RunFetchStoreTests
    {
        private static readonly IOrganizationService UserService = new RecordingFakeService(new EntityCollection[0]);
        private static readonly IOrganizationService SystemService = new RecordingFakeService(new EntityCollection[0]);

        private static TableConfig Child(string link = "parentcustomerid", Guid? id = null) => new TableConfig
        {
            Id = id ?? Guid.NewGuid(), TableLogicalName = "contact",
            ConfigType = TableConfigType.ChildTable, ChildLinkField = link,
        };

        private static HashSet<string> Cols(params string[] names) =>
            new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);

        private sealed class Fetcher
        {
            public int Calls;
            public readonly List<HashSet<string>> Requested = new List<HashSet<string>>();
            public List<Entity> Fetch(HashSet<string> columns)
            {
                Calls++;
                Requested.Add(columns);
                return new List<Entity> { new Entity("contact", Guid.NewGuid()) };
            }
        }

        [Fact]
        public void Same_fetch_is_read_once_and_counted_as_shared()
        {
            var diag = new RunDiagnostics();
            var store = new RunFetchStore(diag);
            var parent = new[] { Guid.NewGuid() };
            var f = new Fetcher();

            var first = store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, Cols("a"), f.Fetch);
            var second = store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, Cols("a"), f.Fetch);

            Assert.Equal(1, f.Calls);
            Assert.Same(first, second);
            Assert.Equal(1, diag.FetchesShared);
            Assert.Equal(0, diag.FetchesWidened);
        }

        [Fact]
        public void Node_id_is_not_part_of_the_key_but_the_link_field_is()
        {
            var store = new RunFetchStore();
            var parent = new[] { Guid.NewGuid() };
            var f = new Fetcher();
            var node = Guid.NewGuid();

            store.GetOrFetch(UserService, FetchKind.Child, Child("parentcustomerid", node), parent, null, Cols("a"), f.Fetch);
            store.GetOrFetch(UserService, FetchKind.Child, Child("parentcustomerid"), parent, null, Cols("a"), f.Fetch);
            Assert.Equal(1, f.Calls);

            store.GetOrFetch(UserService, FetchKind.Child, Child("alternateparentid", node), parent, null, Cols("a"), f.Fetch);
            Assert.Equal(2, f.Calls);
        }

        [Fact]
        public void Services_never_share()
        {
            var store = new RunFetchStore();
            var parent = new[] { Guid.NewGuid() };
            var f = new Fetcher();
            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, Cols("a"), f.Fetch);
            store.GetOrFetch(SystemService, FetchKind.Child, Child(), parent, null, Cols("a"), f.Fetch);
            Assert.Equal(2, f.Calls);
        }

        [Fact]
        public void Scope_order_does_not_matter_but_scope_content_does()
        {
            var store = new RunFetchStore();
            Guid a = Guid.NewGuid(), b = Guid.NewGuid();
            var f = new Fetcher();
            store.GetOrFetch(UserService, FetchKind.Child, Child(), new[] { a, b }, null, Cols("x"), f.Fetch);
            store.GetOrFetch(UserService, FetchKind.Child, Child(), new[] { b, a }, null, Cols("x"), f.Fetch);
            Assert.Equal(1, f.Calls);
            store.GetOrFetch(UserService, FetchKind.Child, Child(), new[] { a }, null, Cols("x"), f.Fetch);
            Assert.Equal(2, f.Calls);
        }

        [Fact]
        public void Different_filters_and_kinds_are_different_fetches()
        {
            var store = new RunFetchStore();
            var parent = new[] { Guid.NewGuid() };
            var f = new Fetcher();
            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, Cols("x"), f.Fetch);
            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, "<filter><condition attribute='x' operator='eq' value='1'/></filter>", Cols("x"), f.Fetch);
            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, "<filter><condition attribute='x' operator='eq' value='2'/></filter>", Cols("x"), f.Fetch);
            Assert.Equal(3, f.Calls);
        }

        [Fact]
        public void Combined_demand_is_the_union_and_full_width_wins()
        {
            var store = new RunFetchStore();
            var node = Child();
            store.DemandColumns(UserService, node, Cols("a"));
            store.DemandColumns(UserService, Child(), Cols("b"));
            Assert.True(store.ColumnsFor(UserService, node, Cols("a")).SetEquals(new[] { "a", "b" }));

            store.DemandColumns(UserService, Child(), null);
            Assert.Null(store.ColumnsFor(UserService, node, Cols("a")));
        }

        [Fact]
        public void Columns_without_registered_demand_are_the_requesters_own()
        {
            var store = new RunFetchStore();
            var own = Cols("a");
            Assert.True(store.ColumnsFor(UserService, Child(), own).SetEquals(own));
            Assert.Null(store.ColumnsFor(UserService, Child(), null));
        }

        [Fact]
        public void A_request_needing_more_columns_widens_and_replaces_the_entry()
        {
            var diag = new RunDiagnostics();
            var store = new RunFetchStore(diag);
            var parent = new[] { Guid.NewGuid() };
            var f = new Fetcher();

            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, Cols("a"), f.Fetch);
            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, Cols("b"), f.Fetch);
            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, Cols("a", "b"), f.Fetch);

            Assert.Equal(2, f.Calls);
            Assert.True(f.Requested[1].SetEquals(new[] { "a", "b" }));
            Assert.Equal(1, diag.FetchesWidened);
            Assert.Equal(1, diag.FetchesShared);
        }

        [Fact]
        public void Full_width_entry_serves_any_columns_and_full_width_request_needs_full_width()
        {
            var store = new RunFetchStore();
            var parent = new[] { Guid.NewGuid() };
            var f = new Fetcher();
            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, Cols("a"), f.Fetch);
            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, null, f.Fetch);
            Assert.Equal(2, f.Calls);
            Assert.Null(f.Requested[1]);
            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, Cols("zzz"), f.Fetch);
            Assert.Equal(2, f.Calls);
        }

        [Fact]
        public void A_failed_fetch_stores_nothing()
        {
            var store = new RunFetchStore();
            var parent = new[] { Guid.NewGuid() };
            Assert.Throws<InvalidOperationException>(() => store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null,
                Cols("a"), _ => throw new InvalidOperationException("boom")));
            var f = new Fetcher();
            store.GetOrFetch(UserService, FetchKind.Child, Child(), parent, null, Cols("a"), f.Fetch);
            Assert.Equal(1, f.Calls);
        }

        private sealed class RootService : IOrganizationService
        {
            public int Calls;
            public readonly List<ColumnSet> ColumnSets = new List<ColumnSet>();
            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                Calls++;
                var q = (QueryExpression)query;
                ColumnSets.Add(q.ColumnSet);
                var c = new EntityCollection();
                foreach (var v in q.Criteria.Conditions[0].Values) c.Entities.Add(new Entity(q.EntityName, (Guid)v) { ["name"] = "Persisted" });
                return c;
            }
            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => throw new NotSupportedException();
            public Guid Create(Entity entity) => throw new NotSupportedException();
            public void Update(Entity entity) => throw new NotSupportedException();
            public void Delete(string entityName, Guid id) => throw new NotSupportedException();
            public OrganizationResponse Execute(OrganizationRequest request) => throw new NotSupportedException();
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
        }

        [Fact]
        public void Root_is_read_once_per_service_with_the_combined_columns()
        {
            var diag = new RunDiagnostics();
            var store = new RunFetchStore(diag);
            var user = new RootService();
            var system = new RootService();
            var inputs = new List<RootInput> { new RootInput { Id = Guid.NewGuid() } };
            store.DemandRootColumns(user, Cols("name"), false);
            store.DemandRootColumns(user, Cols("revenue"), false);
            store.DemandRootColumns(system, Cols("name"), false);

            var first = store.RootsFor(user, "account", inputs);
            var second = store.RootsFor(user, "account", inputs);
            store.RootsFor(system, "account", inputs);

            Assert.Same(first, second);
            Assert.Equal(1, user.Calls);
            Assert.Equal(1, system.Calls);
            Assert.True(new HashSet<string>(user.ColumnSets[0].Columns).SetEquals(new[] { "name", "revenue" }));
            Assert.Equal(1, diag.FetchesShared);
        }

        [Fact]
        public void Any_full_width_root_demand_reads_all_columns()
        {
            var store = new RunFetchStore();
            var user = new RootService();
            store.DemandRootColumns(user, Cols("name"), false);
            store.DemandRootColumns(user, Cols(), true);
            store.RootsFor(user, "account", new List<RootInput> { new RootInput { Id = Guid.NewGuid() } });
            Assert.True(user.ColumnSets[0].AllColumns);
        }
    }
}
