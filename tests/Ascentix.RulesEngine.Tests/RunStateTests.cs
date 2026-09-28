using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RunStateTests
    {
        [Fact]
        public void Record_ids_are_deduplicated_in_first_seen_order()
        {
            var a = Guid.NewGuid(); var b = Guid.NewGuid();
            Assert.Equal(new[] { a, b }, RunState.ParseRecordIds($"[\"{a}\",\"{b}\",\"{a}\"]").ToArray());
        }

        [Fact]
        public void Record_ids_that_are_not_guids_are_refused()
        {
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => RunState.ParseRecordIds("[\"nope\"]"));
            Assert.Equal("Record ids must be a JSON array of record ids.", ex.Message);
        }

        [Fact]
        public void Failures_keep_only_the_first_fifty()
        {
            var many = Enumerable.Range(0, 60).Select(i => new RunFailure(Guid.NewGuid(), "Failed", "e" + i));
            var kept = RunState.ParseFailures(RunState.WriteFailures(many));
            Assert.Equal(50, kept.Count);
            Assert.Equal("e0", kept[0].Message);
        }

        [Fact]
        public void A_bookmark_round_trips_and_an_empty_one_starts_at_page_one()
        {
            var id = Guid.NewGuid();
            var b = RunState.ParseBookmark(RunState.WriteBookmark(new RunBookmark { Index = 3, Page = 2, Cookie = "<cookie page=\"1\"/>", Offset = 7, Skip = new List<Guid> { id } }));
            Assert.Equal(3, b.Index); Assert.Equal(2, b.Page); Assert.Equal("<cookie page=\"1\"/>", b.Cookie); Assert.Equal(7, b.Offset); Assert.Equal(id, b.Skip.Single());
            Assert.Equal(1, RunState.ParseBookmark(null).Page);
        }
    }
}
