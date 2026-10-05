using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Plugin.DataUpdates
{
    public sealed class DataUpdateLimits
    {
        /// <summary>Work stops after this long so the call saves well inside the platform's 2-minute limit.</summary>
        public TimeSpan Budget { get; set; } = TimeSpan.FromSeconds(60);
    }

    public sealed class DataUpdateResult
    {
        public DataUpdateResult(int required, IReadOnlyList<DataUpdateRef> pending, DataUpdateRow latest, bool canApply, bool done)
        {
            Required = required;
            Pending = pending;
            Latest = latest;
            CanApply = canApply;
            Done = done;
        }

        public int Required { get; }
        public IReadOnlyList<DataUpdateRef> Pending { get; }
        public DataUpdateRow Latest { get; }
        public bool CanApply { get; }
        public bool Done { get; }
    }

    /// <summary>
    /// Reports and applies the data updates an assembly carries (docs/Schema.md §10). One call does
    /// at most one budget's work and saves it; callers re-call until Done. A failing item fails the
    /// call with <see cref="ItemFailedPrefix"/> and a failed-item token, <c>&lt;number&gt;/&lt;item&gt;</c>;
    /// the re-call sends the token back, and this records the item against that update and skips it.
    /// </summary>
    public sealed class DataUpdateProcessor
    {
        public const string ItemFailedPrefix = "asx_ApplyDataUpdates:item-failed:";
        public const int MaxFailureMessageLength = 1000;

        private readonly IOrganizationService _system;
        private readonly ITracingService _trace;
        private readonly Guid _callerId;
        private readonly IReadOnlyList<IDataUpdate> _updates;
        private readonly DataUpdateLimits _limits;
        private readonly Func<DateTime> _utcNow;

        public DataUpdateProcessor(IOrganizationService system, ITracingService trace, Guid callerId,
            IEnumerable<IDataUpdate> updates, DataUpdateLimits limits, Func<DateTime> utcNow)
        {
            _system = system;
            _trace = trace;
            _callerId = callerId;
            _updates = updates.OrderBy(u => u.Number).ToList();
            for (var i = 1; i < _updates.Count; i++)
                if (_updates[i].Number == _updates[i - 1].Number)
                    throw new ArgumentException($"Two data updates share number {_updates[i].Number}.", nameof(updates));
            _limits = limits;
            _utcNow = utcNow;
        }

        public DataUpdateResult Status(bool canApply) => Result(DataUpdateRows.Load(_system), canApply);

        public DataUpdateResult Apply(int? retry, string failedItem, string failedMessage)
        {
            var start = _utcNow();
            if (retry.HasValue) StartRetry(retry.Value);

            // The previous call failed on this item and rolled back: record it against the update the token
            // names, make that update skip it, and save without other work. Each report commits in its own
            // call, so an update with several failing items converges.
            if (!string.IsNullOrEmpty(failedItem))
            {
                RecordFailure(failedItem, failedMessage);
                return Result(DataUpdateRows.Load(_system), canApply: true);
            }

            var rows = DataUpdateRows.Load(_system);
            foreach (var update in _updates)
            {
                if (!DataUpdateRows.IsPending(Find(rows, update.Number))) continue;
                var row = Lock(update, Find(rows, update.Number));
                if (!DataUpdateRows.IsPending(row)) continue;   // another caller finished it while we waited

                var context = new DataUpdateContext(_system, _trace, _callerId);
                while (true)
                {
                    DataUpdateStep step;
                    try
                    {
                        step = update.RunStep(context, row.Cursor, () => OverBudget(start));
                    }
                    catch (DataUpdateItemException e)
                    {
                        // Rolls the whole call back; the caller re-calls with this item reported.
                        throw new InvalidPluginExecutionException($"{ItemFailedPrefix}{update.Number}/{e.Item}:{Truncate(e.Message)}");
                    }

                    row.Cursor = step.Cursor;
                    row.Succeeded += step.Succeeded;
                    if (step.Done)
                    {
                        row.State = row.Failed > 0 ? DataUpdateState.CompletedWithFailures : DataUpdateState.Completed;
                        row.CompletedOn = _utcNow();
                        DataUpdateRows.Save(_system, row);
                        _trace?.Trace($"DataUpdateProcessor: update {update.Number} finished ({row.Succeeded} converted, {row.Failed} failed).");
                        return Result(DataUpdateRows.Load(_system), canApply: true);
                    }
                    if (OverBudget(start))
                    {
                        DataUpdateRows.Save(_system, row);
                        return Result(DataUpdateRows.Load(_system), canApply: true);
                    }
                }
            }
            return Result(DataUpdateRows.Load(_system), canApply: true);
        }

        private void StartRetry(int number)
        {
            var update = _updates.FirstOrDefault(u => u.Number == number);
            var existing = Find(DataUpdateRows.Load(_system), number);
            if (update == null || existing == null || existing.State == DataUpdateState.Completed)
                throw new InvalidPluginExecutionException($"asx_ApplyDataUpdates: data update {number} has no failed items to retry.");
            var row = Lock(update, existing);
            // Running: the retry already started (a re-sent request).
            if (row.State != DataUpdateState.CompletedWithFailures) return;
            Reset(row);
            DataUpdateRows.Save(_system, row);
        }

        /// <summary>
        /// Records the item a failed-item token (<c>&lt;number&gt;/&lt;item&gt;</c>) names against that update.
        /// Records nothing when the update isn't in this assembly or another caller has finished it, so a
        /// late report can't land on a different update.
        /// </summary>
        private void RecordFailure(string token, string message)
        {
            var slash = token.IndexOf('/');
            if (slash <= 0 || slash == token.Length - 1 ||
                !int.TryParse(token.Substring(0, slash), NumberStyles.None, CultureInfo.InvariantCulture, out var number))
                throw new InvalidPluginExecutionException($"asx_ApplyDataUpdates: FailedItem '{token}' is not a failed-item token.");
            var item = token.Substring(slash + 1);

            var update = _updates.FirstOrDefault(u => u.Number == number);
            if (update == null) return;
            var existing = Find(DataUpdateRows.Load(_system), number);
            // No row is pending too: the call that would have created it rolled back, so Lock creates it.
            if (!DataUpdateRows.IsPending(existing)) return;
            var row = Lock(update, existing);
            // Another caller finished the update while this call waited; don't record.
            if (!DataUpdateRows.IsPending(row)) return;
            if (row.Failures.Any(f => f.Item == item))
            {
                // A repeated report counts once; skipping again is harmless (Skip is idempotent).
                row.Cursor = update.Skip(row.Cursor, item);
                DataUpdateRows.Save(_system, row);
                return;
            }
            row.Failed++;
            row.Failures.Add(new DataUpdateFailure(item, Truncate(message ?? "The item failed.")));
            row.Cursor = update.Skip(row.Cursor, item);
            DataUpdateRows.Save(_system, row);
        }

        /// <summary>
        /// Creates the update's row (Running) or locks the existing one before trusting its state: the
        /// write's row lock holds until this call's transaction ends, so a second caller waits here and
        /// then reads what this call saved (the RunPageProcessor pattern).
        /// </summary>
        private DataUpdateRow Lock(IDataUpdate update, DataUpdateRow existing)
        {
            var now = _utcNow();
            if (existing == null)
            {
                var created = new DataUpdateRow(update.Number, update.Title)
                {
                    State = DataUpdateState.Running, StartedOn = now, LastPageOn = now, RunBy = _callerId,
                };
                DataUpdateRows.Create(_system, created);
                return created;
            }
            DataUpdateRows.Touch(_system, update.Number, now);
            var row = DataUpdateRows.LoadOne(_system, update.Number);
            row.RunBy = _callerId;
            return row;
        }

        private void Reset(DataUpdateRow row)
        {
            row.State = DataUpdateState.Running;
            row.Cursor = null;
            row.Succeeded = 0;
            row.Failed = 0;
            row.Failures.Clear();
            row.StartedOn = _utcNow();
            row.CompletedOn = null;
            row.RunBy = _callerId;
        }

        private DataUpdateResult Result(Dictionary<int, DataUpdateRow> rows, bool canApply)
        {
            var pending = _updates.Where(u => DataUpdateRows.IsPending(Find(rows, u.Number)))
                .Select(u => new DataUpdateRef(u.Number, u.Title)).ToList();
            var latest = rows.Values
                .OrderByDescending(r => r.LastPageOn ?? r.StartedOn ?? DateTime.MinValue)
                .ThenByDescending(r => r.Number)
                .FirstOrDefault();
            var required = _updates.Count == 0 ? 0 : _updates[_updates.Count - 1].Number;
            return new DataUpdateResult(required, pending, latest, canApply, pending.Count == 0);
        }

        private static DataUpdateRow Find(Dictionary<int, DataUpdateRow> rows, int number) =>
            rows.TryGetValue(number, out var row) ? row : null;

        private bool OverBudget(DateTime start) => _utcNow() - start >= _limits.Budget;

        private static string Truncate(string message) =>
            message == null || message.Length <= MaxFailureMessageLength ? message : message.Substring(0, MaxFailureMessageLength);
    }
}
