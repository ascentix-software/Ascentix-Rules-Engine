using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// The result cache's read contract. "Fetched and matched nothing" (a stored empty list) and
    /// "never fetched" are different facts: the first is an ordinary evaluation input, the
    /// second is an engine planning fault: a consumer reading through it would reach a
    /// confident, wrong verdict against an empty collection. A never-fetched read throws and
    /// names the node; <see cref="QueryResultCache.Has"/> is the non-throwing probe.
    /// </summary>
    public class QueryResultCacheTests
    {
        [Fact]
        public void Store_then_Get_round_trips_the_same_list()
        {
            var nodeId = Guid.NewGuid();
            var rows = new List<Entity> { new Entity("account", Guid.NewGuid()) };
            var cache = new QueryResultCache();

            cache.Store(nodeId, rows);

            Assert.Same(rows, cache.Get(nodeId));
            Assert.Equal(new[] { rows[0].Id }, cache.GetIds(nodeId).ToArray());
        }

        [Fact]
        public void Get_of_a_stored_empty_list_returns_empty_not_throws()
        {
            var nodeId = Guid.NewGuid();
            var cache = new QueryResultCache();
            cache.Store(nodeId, new List<Entity>());

            Assert.Empty(cache.Get(nodeId));
            Assert.Empty(cache.GetIds(nodeId));
            Assert.True(cache.Has(nodeId));
        }

        [Fact]
        public void Get_of_a_never_stored_node_throws_a_planning_fault_naming_the_node()
        {
            var nodeId = Guid.NewGuid();
            var cache = new QueryResultCache();

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => cache.Get(nodeId));

            Assert.Contains(nodeId.ToString(), ex.Message);
            Assert.Contains("planning fault", ex.Message);
            Assert.Contains("unfiltered", ex.Message);
        }

        [Fact]
        public void GetIds_of_a_never_stored_node_throws_too()
        {
            var nodeId = Guid.NewGuid();
            var cache = new QueryResultCache();

            // GetIds is lazy over Get; forcing enumeration is what a consumer does.
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => cache.GetIds(nodeId).ToList());
            Assert.Contains(nodeId.ToString(), ex.Message);
        }

        [Fact]
        public void Never_stored_read_names_the_table_when_the_config_tree_is_known()
        {
            var nodeId = Guid.NewGuid();
            var configs = TestTree.RawTree(TestTree.Node(nodeId, "sample_orderline", TableConfigType.ChildTable, null, "sample_orderid"));
            var cache = new QueryResultCache(configs);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => cache.Get(nodeId));

            Assert.Contains("sample_orderline", ex.Message);
            Assert.Contains(nodeId.ToString(), ex.Message);
        }

        [Fact]
        public void Variant_and_unfiltered_entries_are_distinct()
        {
            var nodeId = Guid.NewGuid();
            var unfiltered = new List<Entity> { new Entity("a", Guid.NewGuid()), new Entity("a", Guid.NewGuid()) };
            var filtered = new List<Entity> { unfiltered[0] };
            var cache = new QueryResultCache();

            cache.Store(nodeId, unfiltered);
            cache.Store(nodeId, "status-eq-1", filtered);

            Assert.Same(unfiltered, cache.Get(nodeId));
            Assert.Same(filtered, cache.Get(nodeId, "status-eq-1"));
            Assert.True(cache.Has(nodeId));
            Assert.True(cache.Has(nodeId, "status-eq-1"));
            Assert.False(cache.Has(nodeId, "other"));
        }

        [Fact]
        public void Storing_only_a_variant_does_not_make_the_unfiltered_read_succeed_and_vice_versa()
        {
            var variantOnly = Guid.NewGuid();
            var unfilteredOnly = Guid.NewGuid();
            var cache = new QueryResultCache();
            cache.Store(variantOnly, "k", new List<Entity>());
            cache.Store(unfilteredOnly, new List<Entity>());

            Assert.False(cache.Has(variantOnly));
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => cache.Get(variantOnly));
            Assert.Contains("unfiltered", ex.Message);

            Assert.False(cache.Has(unfilteredOnly, "k"));
            var ex2 = Assert.Throws<InvalidPluginExecutionException>(() => cache.Get(unfilteredOnly, "k"));
            Assert.Contains("variant 'k'", ex2.Message);
        }

        [Fact]
        public void A_null_or_empty_variant_key_reads_the_unfiltered_entry()
        {
            var nodeId = Guid.NewGuid();
            var rows = new List<Entity>();
            var cache = new QueryResultCache();
            cache.Store(nodeId, rows);

            Assert.Same(rows, cache.Get(nodeId, null));
            Assert.Same(rows, cache.Get(nodeId, ""));
            Assert.True(cache.Has(nodeId, null));
            Assert.True(cache.Has(nodeId, ""));
        }

        [Fact]
        public void Has_is_false_for_a_never_stored_node_and_never_throws()
        {
            var cache = new QueryResultCache();

            Assert.False(cache.Has(Guid.NewGuid()));
            Assert.False(cache.Has(Guid.NewGuid(), "k"));
        }
    }
}
