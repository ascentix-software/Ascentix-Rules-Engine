using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Plugin.DataUpdates;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class DataUpdateProcessorTests
    {
        private static readonly DateTime T0 = new DateTime(2026, 10, 5, 12, 0, 0, DateTimeKind.Utc);
        private readonly IOrganizationService _service = new XrmFakedContext().GetOrganizationService();
        private DateTime _now = T0;
        private readonly Guid _caller = Guid.NewGuid();

        // Items "i1".."iN". Cursor "<next index>|<skipped,...>". Fails decides which items throw.
        private sealed class ItemsUpdate : IDataUpdate
        {
            private readonly int _items;
            private readonly Action _onItem;
            public ItemsUpdate(int number, int items, Action onItem = null) { Number = number; _items = items; _onItem = onItem; }
            public int Number { get; }
            public string Title => "Test update " + Number;
            public Func<string, bool> Fails { get; set; } = _ => false;
            public int Slices { get; private set; }

            public DataUpdateStep RunStep(DataUpdateContext context, string cursor, Func<bool> overBudget)
            {
                Slices++;
                var (next, skipped) = Parse(cursor);
                var succeeded = 0;
                while (next < _items && !overBudget())
                {
                    var item = "i" + (next + 1);
                    if (!skipped.Contains(item))
                    {
                        if (Fails(item)) throw new DataUpdateItemException(item, "boom " + item);
                        succeeded++;
                        _onItem?.Invoke();
                    }
                    next++;
                }
                return new DataUpdateStep(Write(next, skipped), next >= _items, succeeded);
            }

            public string Skip(string cursor, string item)
            {
                var (next, skipped) = Parse(cursor);
                skipped.Add(item);
                return Write(next, skipped);
            }

            private static (int, HashSet<string>) Parse(string cursor)
            {
                if (string.IsNullOrEmpty(cursor)) return (0, new HashSet<string>());
                var parts = cursor.Split('|');
                return (int.Parse(parts[0]), new HashSet<string>(parts[1].Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries)));
            }

            private static string Write(int next, HashSet<string> skipped) =>
                next + "|" + string.Join(",", skipped.OrderBy(s => s, StringComparer.Ordinal));
        }

        private DataUpdateProcessor Processor(params IDataUpdate[] updates) => Processor(new DataUpdateLimits(), updates);

        private DataUpdateProcessor Processor(DataUpdateLimits limits, params IDataUpdate[] updates) =>
            new DataUpdateProcessor(_service, new XrmFakedTracingService(), _caller, updates, limits, () => _now);

        private DataUpdateRow Row(int number) => DataUpdateRows.Load(_service)[number];

        // Drives Apply as a caller does: re-call with the reported item after each item-failed error.
        private (DataUpdateResult Last, List<string> Reported) Drive(DataUpdateProcessor processor, int? retry = null)
        {
            var reported = new List<string>();
            string failed = null;
            for (var calls = 0; calls < 50; calls++)
            {
                try
                {
                    var result = processor.Apply(retry, failed, failed == null ? null : "boom");
                    failed = null;
                    retry = null;
                    if (result.Done) return (result, reported);
                }
                catch (InvalidPluginExecutionException e) when (e.Message.StartsWith(DataUpdateProcessor.ItemFailedPrefix))
                {
                    failed = e.Message.Substring(DataUpdateProcessor.ItemFailedPrefix.Length).Split(':')[0];
                    reported.Add(failed);
                }
            }
            throw new InvalidOperationException("did not finish");
        }

        [Fact]
        public void With_no_updates_nothing_is_pending_and_apply_writes_nothing()
        {
            var processor = Processor();
            var status = processor.Status(canApply: false);
            Assert.Equal(0, status.Required);
            Assert.Empty(status.Pending);
            Assert.Null(status.Latest);
            Assert.True(status.Done);
            Assert.False(status.CanApply);

            Assert.True(processor.Apply(null, null, null).Done);
            Assert.Empty(DataUpdateRows.Load(_service));
        }

        [Fact]
        public void An_update_without_a_row_is_pending_and_one_apply_completes_it()
        {
            var processor = Processor(new ItemsUpdate(1, 3));
            var before = processor.Status(canApply: true);
            Assert.Equal(1, before.Required);
            Assert.Equal(1, Assert.Single(before.Pending).Number);
            Assert.False(before.Done);

            var result = processor.Apply(null, null, null);

            Assert.True(result.Done);
            Assert.Empty(result.Pending);
            var row = Row(1);
            Assert.Equal(DataUpdateState.Completed, row.State);
            Assert.Equal(3, row.Succeeded);
            Assert.Equal(_caller, row.RunBy);
            Assert.Equal(T0, row.CompletedOn);
            Assert.Equal(1, result.Latest.Number);
        }

        [Fact]
        public void A_page_stops_at_the_budget_and_the_next_call_resumes_from_the_saved_cursor()
        {
            var update = new ItemsUpdate(1, 3, onItem: () => _now = _now.AddSeconds(61));
            var processor = Processor(update);

            var first = processor.Apply(null, null, null);
            Assert.False(first.Done);
            Assert.Equal(DataUpdateState.Running, Row(1).State);
            Assert.Equal(1, Row(1).Succeeded);

            Assert.False(processor.Apply(null, null, null).Done);
            var last = processor.Apply(null, null, null);
            Assert.True(last.Done);
            Assert.Equal(3, Row(1).Succeeded);
            Assert.Equal(DataUpdateState.Completed, Row(1).State);
        }

        [Fact]
        public void A_failed_item_is_reported_recorded_once_skipped_and_the_update_completes_with_failures()
        {
            var update = new ItemsUpdate(1, 3) { Fails = item => item == "i2" };
            var processor = Processor(update);

            var e = Assert.Throws<InvalidPluginExecutionException>(() => processor.Apply(null, null, null));
            Assert.StartsWith(DataUpdateProcessor.ItemFailedPrefix + "i2:boom i2", e.Message);

            var report = processor.Apply(null, "i2", "boom i2");
            Assert.False(report.Done);
            processor.Apply(null, "i2", "boom i2");   // a repeated report counts once
            Assert.Equal(1, Row(1).Failed);

            var last = processor.Apply(null, null, null);
            Assert.True(last.Done);
            var row = Row(1);
            Assert.Equal(DataUpdateState.CompletedWithFailures, row.State);
            Assert.Equal(2, row.Succeeded);
            Assert.Equal(1, row.Failed);
            Assert.Equal("i2", Assert.Single(row.Failures).Item);
            Assert.Empty(last.Pending);
        }

        [Fact]
        public void A_long_failure_message_is_truncated()
        {
            var processor = Processor(new ItemsUpdate(1, 1));
            processor.Apply(null, "i1", new string('x', 5000));
            Assert.Equal(DataUpdateProcessor.MaxFailureMessageLength, Row(1).Failures[0].Message.Length);
        }

        [Fact]
        public void An_update_whose_items_all_fail_completes_with_every_failure_listed()
        {
            var update = new ItemsUpdate(1, 3) { Fails = _ => true };
            var processor = Processor(update);
            var (result, reported) = Drive(processor);

            Assert.Equal(new[] { "i1", "i2", "i3" }, reported);
            Assert.True(result.Done);
            var row = Row(1);
            Assert.Equal(DataUpdateState.CompletedWithFailures, row.State);
            Assert.Equal(0, row.Succeeded);
            Assert.Equal(3, row.Failed);
            Assert.Equal(new[] { "i1", "i2", "i3" }, row.Failures.Select(f => f.Item));
        }

        [Fact]
        public void Retry_runs_a_completed_with_failures_update_again_from_the_start()
        {
            var update = new ItemsUpdate(1, 3) { Fails = item => item == "i2" };
            var processor = Processor(update);
            Drive(processor);
            Assert.Equal(DataUpdateState.CompletedWithFailures, Row(1).State);

            update.Fails = _ => false;
            var result = processor.Apply(1, null, null);

            Assert.True(result.Done);
            var row = Row(1);
            Assert.Equal(DataUpdateState.Completed, row.State);
            Assert.Equal(3, row.Succeeded);
            Assert.Equal(0, row.Failed);
            Assert.Empty(row.Failures);
        }

        [Fact]
        public void Retry_with_a_failed_item_resets_then_records_the_item()
        {
            // Review focus 1: the retry call threw item-failed (its reset rolled back), so the caller
            // re-sends the retry with the failed item.
            var update = new ItemsUpdate(1, 3) { Fails = item => item == "i2" };
            var processor = Processor(update);
            Drive(processor);

            processor.Apply(1, "i3", "boom i3");

            var row = Row(1);
            Assert.Equal(DataUpdateState.Running, row.State);
            Assert.Equal("i3", Assert.Single(row.Failures).Item);
        }

        [Fact]
        public void Retry_sent_again_after_it_started_is_not_an_error()
        {
            var update = new ItemsUpdate(1, 3, onItem: () => _now = _now.AddSeconds(61)) { Fails = item => item == "i2" };
            var processor = Processor(update);
            Drive(processor);
            update.Fails = _ => false;

            processor.Apply(1, null, null);                 // starts the retry, stops at the budget
            Assert.Equal(DataUpdateState.Running, Row(1).State);
            var again = processor.Apply(1, null, null);     // re-sent: continues instead of throwing

            Assert.Equal(DataUpdateState.Running, Row(1).State);
            Assert.False(again.Done);
        }

        [Fact]
        public void Retry_of_an_update_with_nothing_to_retry_is_refused()
        {
            var processor = Processor(new ItemsUpdate(1, 1));
            processor.Apply(null, null, null);

            var e = Assert.Throws<InvalidPluginExecutionException>(() => processor.Apply(1, null, null));
            Assert.Contains("data update 1 has no failed items to retry", e.Message);
            Assert.Throws<InvalidPluginExecutionException>(() => processor.Apply(9, null, null));
        }

        [Fact]
        public void Updates_run_in_number_order_and_duplicate_numbers_are_refused()
        {
            var first = new ItemsUpdate(1, 1);
            var second = new ItemsUpdate(2, 1);
            var processor = Processor(second, first);

            var firstResult = processor.Apply(null, null, null);
            Assert.False(firstResult.Done);
            Assert.True(DataUpdateRows.Load(_service).ContainsKey(1));
            Assert.False(DataUpdateRows.Load(_service).ContainsKey(2));
            Assert.Equal(DataUpdateState.Completed, Row(1).State);

            var secondResult = processor.Apply(null, null, null);
            Assert.True(secondResult.Done);
            Assert.Equal(2, secondResult.Required);

            Assert.Throws<ArgumentException>(() => Processor(new ItemsUpdate(1, 1), new ItemsUpdate(1, 1)));
        }

        [Fact]
        public void A_completed_update_is_not_run_again()
        {
            var update = new ItemsUpdate(1, 2);
            var processor = Processor(update);
            processor.Apply(null, null, null);
            var slices = update.Slices;

            Assert.True(processor.Apply(null, null, null).Done);
            Assert.Equal(slices, update.Slices);
        }

        [Fact]
        public void A_failed_item_with_nothing_pending_is_refused()
        {
            var processor = Processor(new ItemsUpdate(1, 1));
            processor.Apply(null, null, null);
            Assert.Throws<InvalidPluginExecutionException>(() => processor.Apply(null, "i1", "boom"));
        }

        [Fact]
        public void A_failed_item_for_an_update_another_caller_finished_is_not_recorded()
        {
            // Another caller finishes the update while this call waits at Lock.
            // The pre-lock pending check finds nothing, so it throws the error before Lock.
            DataUpdateRows.Create(_service, new DataUpdateRow(1, "t") { State = DataUpdateState.Running });
            DataUpdateRows.Save(_service, new DataUpdateRow(1, "t") { State = DataUpdateState.Completed });

            var processor = Processor(new ItemsUpdate(1, 1));
            var e = Assert.Throws<InvalidPluginExecutionException>(() => processor.Apply(null, "i1", "boom"));
            Assert.Contains("no data update is pending", e.Message);
        }

        [Fact]
        public void A_row_whose_update_left_the_assembly_is_not_pending_but_can_be_latest()
        {
            // Review focus 4.
            DataUpdateRows.Create(_service, new DataUpdateRow(7, "Old") { State = DataUpdateState.Running, LastPageOn = T0 });
            var status = Processor(new ItemsUpdate(1, 1)).Status(canApply: true);

            Assert.Equal(new[] { 1 }, status.Pending.Select(p => p.Number));
            Assert.Equal(7, status.Latest.Number);
        }

        [Fact]
        public void The_gate_reports_the_first_pending_update_and_reads_nothing_when_there_are_none()
        {
            var counting = new CountingOrganizationService(_service);
            Assert.Null(DataUpdateGate.FirstPending(counting, Array.Empty<IDataUpdate>()));
            Assert.Empty(counting.RetrieveMultipleByTable);

            var one = new ItemsUpdate(1, 1);
            var two = new ItemsUpdate(2, 1);
            Assert.Same(one, DataUpdateGate.FirstPending(_service, new IDataUpdate[] { one, two }));

            DataUpdateRows.Create(_service, new DataUpdateRow(1, "t") { State = DataUpdateState.CompletedWithFailures });
            Assert.Same(two, DataUpdateGate.FirstPending(_service, new IDataUpdate[] { one, two }));
            Assert.Equal("An administrator must apply data update 2 before rules can be published.", DataUpdateGate.PublishRefusal(2));
        }
    }
}
