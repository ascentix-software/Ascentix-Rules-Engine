using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>How much one asx_ProcessRunPage call may do. Settable so tests can shrink them.
    /// The budget leaves headroom under the platform's two-minute plug-in timeout: it is checked
    /// before each chunk and after each record, so the slowest record still has room to finish.</summary>
    public sealed class RunPageLimits
    {
        public int PageSize { get; set; } = 500;
        public int ChunkSize { get; set; } = 25;
        public TimeSpan Budget { get; set; } = TimeSpan.FromSeconds(60);
        public int SafetyStopAfter { get; set; } = 100;
    }

    /// <summary>A Rule Run's status and running totals after one page.</summary>
    public sealed class RunPageResult
    {
        public bool Done { get; set; }
        public RuleRunStatus Status { get; set; }
        public int Evaluated { get; set; }
        public int Changed { get; set; }
        public int Blocked { get; set; }
        public int Failed { get; set; }
        public int Skipped { get; set; }
    }

    /// <summary>
    /// Advances one Rule Run (asx_rulerun) by a page of records: selects the page from the
    /// bookmark (the given ids, or the rule's table ordered by primary id), evaluates the run's
    /// rule in chunks, applies each unblocked record's writes, and saves the counts, bookmark,
    /// failures and rule versions in one update. A failed write throws
    /// <c>asx_ProcessRunPage:record-failed:&lt;id&gt;:&lt;message&gt;</c> so the platform rolls the
    /// page back; the caller re-calls with that id as FailedRecordId, which only counts it Failed
    /// once and adds it to the skip list; the call after that re-processes the page without it.
    /// </summary>
    public sealed class RunPageProcessor
    {
        public const string RecordFailedPrefix = "asx_ProcessRunPage:record-failed:";
        public const int MaxFailureMessageLength = 1000;

        private const string NotPublishedMessage = "The rule is not published with the On demand trigger.";
        private const string ScopeMismatchMessage = "The run no longer matches its rule's Runs for setting.";

        private static string Q(string fragment) => SchemaNames.Qualify(fragment);

        private readonly IOrganizationService _system;
        private readonly IOrganizationService _user;
        private readonly int _languageId;
        private readonly ITracingService _trace;
        private readonly bool _engineInitiated;
        private readonly RunPageLimits _limits;
        private readonly Func<DateTime> _utcNow;
        private readonly RunDiagnostics _diagnostics;
        private int _startEvaluated, _startBlocked, _startFailed;

        /// <param name="diagnostics">Receives the page stages and counters, and absorbs each chunk's
        /// engine diagnostics and the write stages; null ⇒ none.</param>
        public RunPageProcessor(IOrganizationService system, IOrganizationService user, int languageId,
            ITracingService trace, bool engineInitiated, RunPageLimits limits, Func<DateTime> utcNow,
            RunDiagnostics diagnostics = null)
        {
            _system = system;
            _user = user;
            _languageId = languageId;
            _trace = trace;
            _engineInitiated = engineInitiated;
            _limits = limits;
            _utcNow = utcNow;
            _diagnostics = diagnostics;
        }

        /// <summary>The run's state as loaded, then mutated by the page and saved in one update.</summary>
        private sealed class RunRow
        {
            public RuleRunStatus Status;
            public int Evaluated, Changed, Blocked, Failed, Skipped;
            public List<RunFailure> Failures;
            public RunBookmark Bookmark;
            public List<Guid> Versions;
            public DateTime? LastPageOn;
            public DateTime? FinishedOn;

            public RunPageResult ToResult(bool done) => new RunPageResult
            {
                Done = done,
                Status = Status,
                Evaluated = Evaluated,
                Changed = Changed,
                Blocked = Blocked,
                Failed = Failed,
                Skipped = Skipped,
            };
        }

        public RunPageResult Process(Guid runId, Guid? failedRecordId, string failedMessage)
        {
            var start = _utcNow();
            var entity = Q(SchemaNames.RuleRun.Entity);
            var run = _system.Retrieve(entity, runId, new ColumnSet(true));
            var row = Load(run);

            // A terminal run (completed, failed or cancelled) is reported as it stands.
            if (!IsActive(row.Status)) return row.ToResult(done: true);

            // Lock the run row before reading its state: the update's row lock holds until this
            // page's transaction ends, so a second driver on the same run (another tab, a resumed
            // dialog) waits here and then reads the state this page saved instead of re-running
            // the same bookmark, and a cancel waits for the page rather than racing its save.
            _system.Update(new Entity(entity, runId) { [Q(SchemaNames.RuleRun.LastPageOn)] = _utcNow() });
            run = _system.Retrieve(entity, runId, new ColumnSet(true));
            row = Load(run);
            if (!IsActive(row.Status)) return row.ToResult(done: true);

            // The page's counters are what this call adds to the run's running totals.
            _startEvaluated = row.Evaluated;
            _startBlocked = row.Blocked;
            _startFailed = row.Failed;

            var ids = RunState.ParseRecordIds(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.RecordIds)));
            row.Bookmark = RunState.ParseBookmark(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.Bookmark)));
            row.Failures = RunState.ParseFailures(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.Failures)));
            row.Versions = RunState.ParseVersions(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.RuleVersions)));
            var allRecords = run.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleRun.Scope))?.Value == (int)OnDemandScope.AllRecords;

            // The previous call threw record-failed for this id and was rolled back: count it once,
            // add it to the skip list, and save without processing anything. Committing each report
            // in its own call lets a page with several failing writes converge; the next call
            // re-processes the page without the skipped ids.
            if (failedRecordId.HasValue)
            {
                if (!row.Bookmark.Skip.Contains(failedRecordId.Value))
                {
                    row.Bookmark.Skip.Add(failedRecordId.Value);
                    row.Evaluated++;
                    row.Failed++;
                    row.Failures.Add(Failure(failedRecordId.Value, "Failed", failedMessage ?? "The write failed."));
                }
                if (row.Status == RuleRunStatus.Queued) row.Status = RuleRunStatus.Running;
                row.LastPageOn = _utcNow();
                if (SafetyStop(row)) return Finish(runId, row, RuleRunStatus.Failed);
                return Save(runId, row, done: false);
            }

            OnDemandRule rule;
            try
            {
                rule = OnDemandRules.Resolve(_system, run.GetAttributeValue<EntityReference>(Q(SchemaNames.RuleRun.Rule))?.Id ?? Guid.Empty, _trace);
            }
            catch (InvalidPluginExecutionException e) when (e.Message == NotPublishedMessage)
            {
                row.Failures.Add(Failure(Guid.Empty, "Failed", "The rule is no longer published with the On demand trigger."));
                return Finish(runId, row, RuleRunStatus.Failed);
            }

            // The run must still match its rule's Runs for setting: an all-records run needs an
            // All records rule and no record ids; a given-records run needs its ids. Checked on
            // every page, so neither a republish nor an edit to the run widens what it touches.
            var scopeMatches = allRecords ? rule.Scope == OnDemandScope.AllRecords && ids.Count == 0 : ids.Count > 0;
            if (!scopeMatches)
            {
                row.Failures.Add(Failure(Guid.Empty, "Failed", ScopeMismatchMessage));
                return Finish(runId, row, RuleRunStatus.Failed);
            }

            if (rule.PublishedRevisionId.HasValue && !row.Versions.Contains(rule.PublishedRevisionId.Value))
                row.Versions.Add(rule.PublishedRevisionId.Value);

            if (row.Status == RuleRunStatus.Queued) row.Status = RuleRunStatus.Running;
            row.LastPageOn = _utcNow();

            var evaluator = new OnDemandEvaluator(_system, _user, _languageId, _trace);

            // Select the page window.
            List<Guid> window;
            bool more;
            string pagingCookie = null;
            using (_diagnostics?.Time("pageSelect"))
            {
                if (allRecords)
                {
                    var query = new QueryExpression(rule.Table)
                    {
                        ColumnSet = new ColumnSet(false),
                        PageInfo = new PagingInfo { Count = _limits.PageSize, PageNumber = row.Bookmark.Page },
                    };
                    if (row.Bookmark.Cookie != null) query.PageInfo.PagingCookie = row.Bookmark.Cookie;
                    query.AddOrder(rule.Table + "id", OrderType.Ascending);
                    // Enumerated in the rule's evaluation context, so a User rule never pages over a
                    // row its starter can't read.
                    var result = evaluator.ReadService(rule).RetrieveMultiple(query);
                    // The whole page every time: a resumed page skips what it already handled by id (the
                    // skip list), so rows deleted or inserted since the last call can't shift it.
                    window = result.Entities.Select(e => e.Id).ToList();
                    more = result.MoreRecords;
                    pagingCookie = result.PagingCookie;
                }
                else
                {
                    window = ids.Skip(row.Bookmark.Index).Take(_limits.PageSize).ToList();
                    more = row.Bookmark.Index + window.Count < ids.Count;
                }
            }

            // Walk the window (minus the skip list) in chunks, until the page size or time budget.
            var skip = new HashSet<Guid>(row.Bookmark.Skip);
            var executor = new WriteActionExecutor();
            var consumed = 0;   // positions of the window walked, skipped ids included
            var processed = 0;
            var budgetCut = false;
            while (consumed < window.Count && processed < _limits.PageSize && !OverBudget(start))
            {
                var chunk = new List<Guid>();
                var positions = new Dictionary<Guid, int>();   // each chunk id's position in the window
                while (consumed < window.Count && chunk.Count < _limits.ChunkSize)
                {
                    var position = consumed++;
                    var id = window[position];
                    if (skip.Contains(id)) continue;
                    chunk.Add(id);
                    positions[id] = position;
                }
                if (chunk.Count == 0) continue;
                processed += chunk.Count;
                if (_diagnostics != null) _diagnostics.PageChunks++;

                HashSet<Guid> existing;
                using (_diagnostics?.Time("pageEvaluate"))
                    existing = evaluator.Existing(rule, chunk);
                foreach (var missing in chunk.Where(id => !existing.Contains(id)))
                {
                    row.Evaluated++;
                    row.Failed++;
                    row.Failures.Add(Failure(missing, "Failed", "Record not found or not readable."));
                    if (SafetyStop(row)) return Finish(runId, row, RuleRunStatus.Failed);
                }

                var existingIds = chunk.Where(existing.Contains).ToList();
                if (existingIds.Count == 0)
                {
                    if (allRecords) row.Bookmark.Skip.AddRange(chunk);
                    continue;
                }

                RuleEvaluationOutcome outcome;
                using (_diagnostics?.Time("pageEvaluate"))
                    outcome = evaluator.Evaluate(rule, existingIds);
                _diagnostics?.Absorb(outcome.Diagnostics);
                for (var r = 0; r < outcome.Records.Count; r++)
                {
                    var record = outcome.Records[r];
                    row.Evaluated++;
                    if (record.GatedRuleIds.Contains(rule.RuleId))
                    {
                        row.Skipped++;
                    }
                    else if (record.HasBlock)
                    {
                        row.Blocked++;
                        row.Failures.Add(Failure(record.RecordId, "Blocked",
                            ActionDispatcher.FormatBlockMessage(record.BlockingMessages, _languageId)));
                    }
                    else
                    {
                        try
                        {
                            int written;
                            using (_diagnostics?.Time("pageWrite"))
                                written = executor.ExecuteRecord(record, null, _user, _system, _engineInitiated, _trace, _diagnostics);
                            if (written > 0)
                                row.Changed++;
                        }
                        catch (Exception ex)
                        {
                            // Rolls the whole page back; the caller re-calls with this record reported.
                            throw new InvalidPluginExecutionException($"{RecordFailedPrefix}{record.RecordId}:{Truncate(ex.Message)}");
                        }
                    }
                    if (SafetyStop(row)) return Finish(runId, row, RuleRunStatus.Failed);

                    // Over budget mid-chunk: stop after this record, saving progress exactly as a
                    // budget cut between chunks would. The walk rewinds to the first record not yet
                    // evaluated; ids already counted past that point (a missing record) join the
                    // skip list so the next page doesn't count them again.
                    if (r < outcome.Records.Count - 1 && OverBudget(start))
                    {
                        var unhandled = new HashSet<Guid>(existingIds.Skip(r + 1));
                        var handled = chunk.Where(id => !unhandled.Contains(id)).ToList();
                        consumed = positions[existingIds[r + 1]];
                        row.Bookmark.Skip.AddRange(allRecords ? handled : handled.Where(id => positions[id] > consumed));
                        budgetCut = true;
                        break;
                    }
                }
                if (budgetCut) break;

                // An all-records page resumes by id: everything handled so far is skipped next time.
                if (allRecords) row.Bookmark.Skip.AddRange(chunk);
            }

            // Advance the bookmark past what this page consumed. Offset is no longer used (an
            // all-records page resumes through the skip list) and is always written as 0.
            var windowConsumed = consumed == window.Count;
            row.Bookmark.Offset = 0;
            if (allRecords)
            {
                if (windowConsumed)
                {
                    row.Bookmark.Page++;
                    row.Bookmark.Cookie = pagingCookie;
                }
            }
            else
            {
                row.Bookmark.Index += consumed;
            }
            if (windowConsumed) row.Bookmark.Skip.Clear();

            if (windowConsumed && !more)
                return Finish(runId, row, row.Blocked + row.Failed == 0 ? RuleRunStatus.Completed : RuleRunStatus.CompletedWithFailures);

            return Save(runId, row, done: false);
        }

        private bool OverBudget(DateTime start) => _utcNow() - start >= _limits.Budget;

        private static bool IsActive(RuleRunStatus status) =>
            status == RuleRunStatus.Queued || status == RuleRunStatus.Running;

        private static RunRow Load(Entity run) => new RunRow
        {
            Status = (RuleRunStatus)(run.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleRun.Status))?.Value ?? (int)RuleRunStatus.Queued),
            Evaluated = run.GetAttributeValue<int>(Q(SchemaNames.RuleRun.Evaluated)),
            Changed = run.GetAttributeValue<int>(Q(SchemaNames.RuleRun.Changed)),
            Blocked = run.GetAttributeValue<int>(Q(SchemaNames.RuleRun.Blocked)),
            Failed = run.GetAttributeValue<int>(Q(SchemaNames.RuleRun.Failed)),
            Skipped = run.GetAttributeValue<int>(Q(SchemaNames.RuleRun.Skipped)),
        };

        // Failure messages are capped so 50 of them always fit asx_failures (Memo 100,000).
        private static RunFailure Failure(Guid recordId, string kind, string message) =>
            new RunFailure(recordId, kind, Truncate(message));

        private static string Truncate(string message) =>
            message != null && message.Length > MaxFailureMessageLength ? message.Substring(0, MaxFailureMessageLength) : message;

        // Every record so far failed: a misconfigured rule or a run over the wrong table. Stop
        // before failing the rest.
        private bool SafetyStop(RunRow row) =>
            row.Evaluated >= _limits.SafetyStopAfter && row.Failed == row.Evaluated;

        private RunPageResult Finish(Guid runId, RunRow row, RuleRunStatus status)
        {
            row.Status = status;
            row.FinishedOn = _utcNow();
            return Save(runId, row, done: true);
        }

        private RunPageResult Save(Guid runId, RunRow row, bool done)
        {
            if (_diagnostics != null)
            {
                _diagnostics.PageRecords = row.Evaluated - _startEvaluated;
                _diagnostics.PageBlocked = row.Blocked - _startBlocked;
                _diagnostics.PageFailed = row.Failed - _startFailed;
            }
            using (_diagnostics?.Time("bookmark"))
            {
                var entity = Q(SchemaNames.RuleRun.Entity);
                var update = new Entity(entity, runId)
                {
                    [Q(SchemaNames.RuleRun.Evaluated)] = row.Evaluated,
                    [Q(SchemaNames.RuleRun.Changed)] = row.Changed,
                    [Q(SchemaNames.RuleRun.Blocked)] = row.Blocked,
                    [Q(SchemaNames.RuleRun.Failed)] = row.Failed,
                    [Q(SchemaNames.RuleRun.Skipped)] = row.Skipped,
                    [Q(SchemaNames.RuleRun.Bookmark)] = RunState.WriteBookmark(row.Bookmark),
                    [Q(SchemaNames.RuleRun.Failures)] = RunState.WriteFailures(row.Failures),
                    [Q(SchemaNames.RuleRun.RuleVersions)] = RunState.WriteVersions(row.Versions),
                };
                if (row.LastPageOn.HasValue) update[Q(SchemaNames.RuleRun.LastPageOn)] = row.LastPageOn.Value;

                // Cancel guard: a cancel that landed during the page wins; keep its status.
                var current = _system.Retrieve(entity, runId, new ColumnSet(Q(SchemaNames.RuleRun.Status)));
                if (current.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleRun.Status))?.Value == (int)RuleRunStatus.Cancelled)
                {
                    _trace.Trace($"RunPageProcessor: run {runId} was cancelled during the page; keeping Cancelled.");
                    row.Status = RuleRunStatus.Cancelled;
                    done = true;
                }
                else
                {
                    update[Q(SchemaNames.RuleRun.Status)] = new OptionSetValue((int)row.Status);
                    if (row.FinishedOn.HasValue) update[Q(SchemaNames.RuleRun.FinishedOn)] = row.FinishedOn.Value;
                }

                _system.Update(update);
                return row.ToResult(done);
            }
        }
    }
}
