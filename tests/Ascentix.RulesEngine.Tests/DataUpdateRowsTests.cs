using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Plugin.DataUpdates;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class DataUpdateRowsTests
    {
        private static readonly DateTime Now = new DateTime(2026, 10, 5, 12, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void Row_ids_are_fixed_per_number_and_distinct()
        {
            Assert.Equal(DataUpdateRows.RowId(1), DataUpdateRows.RowId(1));
            Assert.NotEqual(DataUpdateRows.RowId(1), DataUpdateRows.RowId(2));
            Assert.NotEqual(Guid.Empty, DataUpdateRows.RowId(0));
        }

        [Fact]
        public void Pending_means_no_row_or_running()
        {
            Assert.True(DataUpdateRows.IsPending(null));
            Assert.True(DataUpdateRows.IsPending(new DataUpdateRow(1, "t") { State = DataUpdateState.Running }));
            Assert.False(DataUpdateRows.IsPending(new DataUpdateRow(1, "t") { State = DataUpdateState.Completed }));
            Assert.False(DataUpdateRows.IsPending(new DataUpdateRow(1, "t") { State = DataUpdateState.CompletedWithFailures }));
        }

        [Fact]
        public void A_row_round_trips_through_create_save_and_load()
        {
            var service = new XrmFakedContext().GetOrganizationService();
            var caller = Guid.NewGuid();
            var row = new DataUpdateRow(3, "Convert things") { State = DataUpdateState.Running, StartedOn = Now, LastPageOn = Now, RunBy = caller };
            DataUpdateRows.Create(service, row);

            row.Cursor = "5|a,b";
            row.Succeeded = 5;
            row.Failed = 1;
            row.Failures.Add(new DataUpdateFailure("a", "boom"));
            row.State = DataUpdateState.CompletedWithFailures;
            row.CompletedOn = Now.AddMinutes(1);
            DataUpdateRows.Save(service, row);

            var loaded = DataUpdateRows.Load(service)[3];
            Assert.Equal("Convert things", loaded.Title);
            Assert.Equal(DataUpdateState.CompletedWithFailures, loaded.State);
            Assert.Equal("5|a,b", loaded.Cursor);
            Assert.Equal(5, loaded.Succeeded);
            Assert.Equal(1, loaded.Failed);
            Assert.Equal("a", Assert.Single(loaded.Failures).Item);
            Assert.Equal(caller, loaded.RunBy);
            Assert.Equal(Now.AddMinutes(1), loaded.CompletedOn);
            Assert.Equal(3, DataUpdateRows.LoadOne(service, 3).Number);
        }

        [Fact]
        public void The_failure_list_keeps_the_first_fifty()
        {
            var failures = Enumerable.Range(1, 60).Select(i => new DataUpdateFailure("i" + i, "m")).ToList();
            var parsed = DataUpdateRows.ParseFailures(DataUpdateRows.WriteFailures(failures));
            Assert.Equal(DataUpdateRows.MaxFailures, parsed.Count);
            Assert.Equal("i1", parsed[0].Item);
            Assert.Empty(DataUpdateRows.ParseFailures(null));
            Assert.Empty(DataUpdateRows.ParseFailures(""));
        }

        [Fact]
        public void Pending_and_latest_serialize_with_camel_case_members()
        {
            Assert.Equal("[{\"number\":1,\"title\":\"One\"}]", DataUpdateRows.WritePending(new[] { new DataUpdateRef(1, "One") }));
            var row = new DataUpdateRow(2, "Two") { State = DataUpdateState.CompletedWithFailures, Succeeded = 4, Failed = 1 };
            row.Failures.Add(new DataUpdateFailure("x", "bad"));
            Assert.Equal("{\"number\":2,\"title\":\"Two\",\"status\":3,\"succeeded\":4,\"failed\":1,\"failures\":[{\"item\":\"x\",\"message\":\"bad\"}]}",
                DataUpdateRows.WriteLatest(row));
        }

        [Theory]
        [InlineData("")]
        [InlineData("a:b")]
        [InlineData("a b")]
        [InlineData("a/b")]
        public void An_item_id_with_a_colon_slash_or_whitespace_is_rejected(string item)
        {
            Assert.Throws<ArgumentException>(() => new DataUpdateItemException(item, "m"));
        }
    }
}
