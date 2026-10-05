using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// A published On demand account rule: execution condition name contains "ZZ"; match
    /// numberofemployees > 10; OnMatch updates description = "big", OnNoMatch blocks "too small".
    /// Accounts ZZ1 (50), ZZ2 (5), ZZ3 (70) and Other (99). Pages of 2, chunks of 1, fixed clock.
    /// </summary>
    public class RunPageProcessorTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private static readonly DateTime Now = new DateTime(2026, 9, 28, 12, 0, 0, DateTimeKind.Utc);

        private readonly XrmFakedContext _ctx = new XrmFakedContext();
        private readonly IOrganizationService _service;
        private readonly Guid _ruleId = Guid.NewGuid();
        private readonly Guid _revisionId = Guid.NewGuid();
        private readonly Guid _zz1 = Guid.NewGuid();
        private readonly Guid _zz2 = Guid.NewGuid();
        private readonly Guid _zz3 = Guid.NewGuid();
        private readonly Guid _other = Guid.NewGuid();
        private readonly Guid _updateActionId = Guid.NewGuid();

        public RunPageProcessorTests()
        {
            _ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new FakeAttributeMetadataExecutor("account",
                new StringAttributeMetadata { LogicalName = "name" },
                new StringAttributeMetadata { LogicalName = "description" },
                new IntegerAttributeMetadata { LogicalName = "numberofemployees" }));

            var cfgId = Guid.NewGuid();
            var execGroup = Guid.NewGuid();
            var matchGroup = Guid.NewGuid();
            var ruleRef = new EntityReference(Q(SchemaNames.Rule.Entity), _ruleId);
            var cfgRef = new EntityReference(Q(SchemaNames.TableConfig.Entity), cfgId);

            _ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), cfgId)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.Rule.Entity), _ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                    [Q(SchemaNames.PrimaryName)] = "Size check",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnDemand) }),
                    [Q(SchemaNames.Rule.OnDemandScope)] = new OptionSetValue((int)OnDemandScope.AllRecords),
                },
                Group(execGroup, ruleRef, isExecutionCondition: true),
                Condition(execGroup, cfgRef, "name", ComparisonOperator.Contains, "ZZ"),
                Group(matchGroup, ruleRef, isExecutionCondition: false),
                Condition(matchGroup, cfgRef, "numberofemployees", ComparisonOperator.GreaterThan, "10"),
                new Entity(Q(SchemaNames.RuleAction.Entity), _updateActionId)
                {
                    [Q(SchemaNames.RuleAction.Rule)] = ruleRef,
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.UpdateRecord),
                    [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                    [Q(SchemaNames.RuleAction.TargetNode)] = cfgRef,
                    [Q(SchemaNames.RuleAction.FieldMapping)] = "[{\"target\":\"description\",\"source\":\"literal\",\"value\":\"big\"}]",
                    [Q(SchemaNames.RuleAction.Order)] = 1,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                },
                new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid())
                {
                    [Q(SchemaNames.RuleAction.Rule)] = ruleRef,
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                    [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnNoMatch),
                    [Q(SchemaNames.RuleAction.Message)] = "too small",
                    [Q(SchemaNames.RuleAction.Order)] = 2,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                },
                new Entity("account", _zz1) { ["name"] = "ZZ1", ["numberofemployees"] = 50 },
                new Entity("account", _zz2) { ["name"] = "ZZ2", ["numberofemployees"] = 5 },
                new Entity("account", _zz3) { ["name"] = "ZZ3", ["numberofemployees"] = 70 },
                new Entity("account", _other) { ["name"] = "Other", ["numberofemployees"] = 99 },
            });
            _service = _ctx.GetOrganizationService();

            Publish(_revisionId);
        }

        // Publish: freeze the authored rows into a revision and point the rule at it.
        private void Publish(Guid revisionId)
        {
            var snapshot = RuleSnapshot.Capture(_service, _ruleId);
            _service.Create(new Entity(Q(SchemaNames.RuleRevision.Entity), revisionId)
            {
                [Q(SchemaNames.RuleRevision.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), _ruleId),
                [Q(SchemaNames.RuleRevision.Definition)] = snapshot.Serialize(),
                [Q(SchemaNames.RuleRevision.Hash)] = snapshot.Hash(),
            });
            _service.Update(new Entity(Q(SchemaNames.Rule.Entity), _ruleId)
            {
                [Q(SchemaNames.Rule.PublishedRevision)] = new EntityReference(Q(SchemaNames.RuleRevision.Entity), revisionId),
            });
        }

        private static Entity Group(Guid id, EntityReference rule, bool isExecutionCondition) =>
            new Entity(Q(SchemaNames.ConditionGroup.Entity), id)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = rule,
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)Ascentix.RulesEngine.Core.Models.LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = isExecutionCondition,
            };

        private static Entity Condition(Guid groupId, EntityReference cfg, string column, ComparisonOperator op, string value) =>
            new Entity(Q(SchemaNames.RuleCondition.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), groupId),
                [Q(SchemaNames.RuleCondition.TableConfig)] = cfg,
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = column,
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)op),
                [Q(SchemaNames.RuleCondition.ComparisonValue)] = value,
            };

        private Guid SeedRun(OnDemandScope scope, IEnumerable<Guid> ids = null, RuleRunStatus status = RuleRunStatus.Queued)
        {
            var run = new Entity(Q(SchemaNames.RuleRun.Entity))
            {
                [Q(SchemaNames.RuleRun.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), _ruleId),
                [Q(SchemaNames.RuleRun.Scope)] = new OptionSetValue((int)scope),
                [Q(SchemaNames.RuleRun.Status)] = new OptionSetValue((int)status),
                [Q(SchemaNames.RuleRun.Evaluated)] = 0,
                [Q(SchemaNames.RuleRun.Changed)] = 0,
                [Q(SchemaNames.RuleRun.Blocked)] = 0,
                [Q(SchemaNames.RuleRun.Failed)] = 0,
                [Q(SchemaNames.RuleRun.Skipped)] = 0,
            };
            if (ids != null) run[Q(SchemaNames.RuleRun.RecordIds)] = RunState.WriteRecordIds(ids);
            return _service.Create(run);
        }

        private static RunPageLimits Limits() => new RunPageLimits { PageSize = 2, ChunkSize = 1 };

        private RunPageProcessor Processor(RunPageLimits limits = null, IOrganizationService service = null, Func<DateTime> clock = null,
            IOrganizationService user = null, WriteActionExecutor executor = null)
        {
            var svc = service ?? _service;
            return new RunPageProcessor(svc, user ?? svc, 1033, new XrmFakedTracingService(), engineInitiated: false,
                limits ?? Limits(), clock ?? (() => Now), executor: executor);
        }

        private sealed class AlwaysBulk : IBulkWriteSupport { public bool Supports(string message, string table) => true; }

        // Applies UpdateMultiple/Update targets through the fake service (FakeXrmEasy has no UpdateMultiple),
        // failing on one account id when asked.
        private sealed class BulkSender : IWriteRequestSender
        {
            public readonly List<OrganizationRequest> Sent = new List<OrganizationRequest>();
            public Guid? FailOn;
            public readonly HashSet<Guid> AlsoFailOn = new HashSet<Guid>();
            public Action OnSend;
            public void Send(IOrganizationService service, OrganizationRequest request)
            {
                Sent.Add(request);
                OnSend?.Invoke();
                var targets = request is UpdateMultipleRequest m ? m.Targets.Entities.ToList()
                    : request is UpdateRequest u ? new List<Entity> { u.Target } : null;
                if (targets == null) { service.Execute(request); return; }
                if (targets.Any(t => t.Id == FailOn || AlsoFailOn.Contains(t.Id))) throw new InvalidOperationException("boom");
                foreach (var t in targets) service.Update(t);
            }
        }

        private static WriteActionExecutor BulkExecutor(BulkSender sender) => new WriteActionExecutor(_ => new AlwaysBulk(), sender);

        private RunBookmark BookmarkOf(Guid runId) =>
            RunState.ParseBookmark(Run(runId).GetAttributeValue<string>(Q(SchemaNames.RuleRun.Bookmark)));

        // Ids that sort the same way by .NET Guid comparison and by SQL uniqueidentifier order.
        private static Guid OrderedId(int n) => new Guid($"00000000-0000-0000-0000-{n:D12}");

        // A proxy that counts account writes per id and moves the clock past the default 60 s
        // budget on each one, so every page stops after its first write.
        private (ProxyService Proxy, Dictionary<Guid, int> Writes, Func<DateTime> Clock) BudgetCutProxy()
        {
            var now = Now;
            var writes = new Dictionary<Guid, int>();
            var proxy = new ProxyService(_service)
            {
                OnExecute = request =>
                {
                    if (request is UpdateRequest u && u.Target.LogicalName == "account")
                    {
                        writes[u.Target.Id] = writes.TryGetValue(u.Target.Id, out var n) ? n + 1 : 1;
                        now = now.AddMinutes(5);
                    }
                }
            };
            return (proxy, writes, () => now);
        }

        private static (RunPageResult Last, int Calls) ProcessUntilDone(RunPageProcessor processor, Guid runId)
        {
            for (var calls = 1; calls <= 20; calls++)
            {
                var result = processor.Process(runId, null, null);
                if (result.Done) return (result, calls);
            }
            throw new InvalidOperationException("The run did not finish within 20 pages.");
        }

        private Entity Run(Guid runId) => _service.Retrieve(Q(SchemaNames.RuleRun.Entity), runId, new ColumnSet(true));

        private static RuleRunStatus StatusOf(Entity run) =>
            (RuleRunStatus)run.GetAttributeValue<OptionSetValue>(Q(SchemaNames.RuleRun.Status)).Value;

        private static int Count(Entity run, string fragment) => run.GetAttributeValue<int>(Q(fragment));

        private static List<RunFailure> FailuresOf(Entity run) =>
            RunState.ParseFailures(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.Failures)));

        private string Description(Guid accountId) =>
            _service.Retrieve("account", accountId, new ColumnSet("description")).GetAttributeValue<string>("description");

        [Fact]
        public void Diagnostics_time_the_page_and_count_what_it_handled()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz2, _zz3 });
            var diag = new RunDiagnostics();
            var processor = new RunPageProcessor(_service, _service, 1033, new XrmFakedTracingService(), engineInitiated: false,
                new RunPageLimits { PageSize = 10, ChunkSize = 2 }, () => Now, diag);

            var result = processor.Process(runId, null, null);

            Assert.True(result.Done);
            Assert.Equal(3, diag.PageRecords);
            Assert.Equal(2, diag.PageChunks);
            Assert.Equal(1, diag.PageBlocked);  // ZZ2 (5 employees) blocks
            Assert.Equal(0, diag.PageFailed);
            Assert.Equal(2, diag.WritesSent);   // ZZ1 and ZZ3 get description = "big"
            foreach (var stage in new[] { "pageSelect", "pageEvaluate", "pageWrite", "bookmark",
                         "ruleLoad", "evaluate", "changeSetBuild", "dispatch:Update:account" })
                Assert.Contains(diag.Stages, s => s.Name == stage);
        }

        [Fact]
        public void A_group_is_written_with_one_UpdateMultiple()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz2, _zz3 });
            var sender = new BulkSender();
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 3 }, executor: BulkExecutor(sender));

            var (last, _) = ProcessUntilDone(processor, runId);

            var bulk = Assert.Single(sender.Sent.OfType<UpdateMultipleRequest>());
            Assert.Equal(2, bulk.Targets.Entities.Count);
            Assert.DoesNotContain(sender.Sent, r => r is UpdateRequest);
            Assert.Equal(3, last.Evaluated);
            Assert.Equal(2, last.Changed);
            Assert.Equal(1, last.Blocked);
            Assert.NotNull(Description(_zz1));
            Assert.NotNull(Description(_zz3));
        }

        [Fact]
        public void A_failed_batch_isolates_its_group_and_the_bad_record_is_counted_as_today()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz2, _zz3 });
            var sender = new BulkSender { FailOn = _zz3 };
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 3 }, executor: BulkExecutor(sender));

            // 1. The batch fails: today's error, with the group's stand-in id.
            var batch = Assert.Throws<InvalidPluginExecutionException>(() => processor.Process(runId, null, null));
            var standIn = RunPageProcessor.StandIn(_zz1);
            Assert.StartsWith(RunPageProcessor.RecordFailedPrefix + standIn + ":" + RunPageProcessor.IsolatingMessage, batch.Message);

            // 2. The re-call with the stand-in counts nothing and marks the group.
            var marked = processor.Process(runId, standIn, "ignored");
            Assert.Equal(0, marked.Evaluated + marked.Failed);
            Assert.Equal(new[] { _zz1 }, BookmarkOf(runId).Isolate);
            Assert.Equal(1, BookmarkOf(runId).BatchFailures);

            // 3. The group now writes per record and fails on the real record.
            var real = Assert.Throws<InvalidPluginExecutionException>(() => processor.Process(runId, null, null));
            Assert.StartsWith(RunPageProcessor.RecordFailedPrefix + _zz3 + ":", real.Message);

            // 4. Today's re-call counts it; the run completes.
            processor.Process(runId, _zz3, "boom");
            var (last, _) = ProcessUntilDone(processor, runId);
            Assert.Equal(3, last.Evaluated);
            Assert.Equal(1, last.Changed);
            Assert.Equal(1, last.Blocked);
            Assert.Equal(1, last.Failed);
            Assert.Contains(FailuresOf(Run(runId)), f => f.RecordId == _zz3 && f.Kind == "Failed");
            Assert.DoesNotContain(FailuresOf(Run(runId)), f => f.RecordId == standIn);
            Assert.Empty(BookmarkOf(runId).Isolate);
        }

        [Fact]
        public void A_failed_group_stays_isolated_when_its_first_record_is_the_one_that_failed()
        {
            // The group's first record fails and is skipped, so the next call's group starts with another
            // id. It must still write one record at a time: batching again would fail on the second bad
            // record and report another stand-in.
            var ids = Enumerable.Range(1, 4).Select(OrderedId).ToList();
            foreach (var id in ids)
                _service.Create(new Entity("account", id) { ["name"] = "ZZ" + id, ["numberofemployees"] = 50 });
            var runId = SeedRun(OnDemandScope.GivenRecord, ids);
            var sender = new BulkSender { FailOn = ids[0] };
            sender.AlsoFailOn.Add(ids[2]);
            var processor = Processor(new RunPageLimits { PageSize = 4, ChunkSize = 4 }, executor: BulkExecutor(sender));

            // Drive the run as a caller does: re-call with the reported id after each record-failed error.
            var reported = new List<Guid>();
            RunPageResult last = null;
            Guid? failedId = null;
            for (var calls = 0; calls < 20 && (last == null || !last.Done); calls++)
            {
                try
                {
                    last = processor.Process(runId, failedId, failedId.HasValue ? "boom" : null);
                    failedId = null;
                }
                catch (InvalidPluginExecutionException e) when (e.Message.StartsWith(RunPageProcessor.RecordFailedPrefix))
                {
                    failedId = Guid.Parse(e.Message.Substring(RunPageProcessor.RecordFailedPrefix.Length, 36));
                    reported.Add(failedId.Value);
                }
            }

            Assert.Equal(new[] { RunPageProcessor.StandIn(ids[0]), ids[0], ids[2] }, reported);
            Assert.Single(sender.Sent.OfType<UpdateMultipleRequest>());
            Assert.True(last.Done);
            Assert.Equal(2, last.Changed);
            Assert.Equal(2, last.Failed);
            Assert.Equal(1, BookmarkOf(runId).BatchFailures);
            Assert.Empty(BookmarkOf(runId).Isolate);
        }

        [Fact]
        public void A_third_failed_batch_switches_the_run_to_single_writes()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz2, _zz3 });
            var bookmark = new RunBookmark { BatchFailures = RunPageProcessor.BatchFailuresBeforeSingleWrites - 1 };
            _service.Update(new Entity(Q(SchemaNames.RuleRun.Entity), runId) { [Q(SchemaNames.RuleRun.Bookmark)] = RunState.WriteBookmark(bookmark) });
            var sender = new BulkSender();
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 3 }, executor: BulkExecutor(sender));

            processor.Process(runId, RunPageProcessor.StandIn(_zz1), "ignored");
            Assert.True(BookmarkOf(runId).SingleWrites);

            ProcessUntilDone(processor, runId);
            Assert.Empty(sender.Sent.OfType<UpdateMultipleRequest>());
            Assert.Equal(2, sender.Sent.OfType<UpdateRequest>().Count());
        }

        [Fact]
        public void An_id_that_decodes_to_no_record_of_the_run_is_counted_failed_as_today()
        {
            // An id that decodes to no existing record is not a stand-in: it is counted Failed, as today.
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1 });
            var notAStandIn = RunPageProcessor.StandIn(Guid.NewGuid());
            var result = Processor(executor: BulkExecutor(new BulkSender())).Process(runId, notAStandIn, "boom");
            Assert.Equal(1, result.Failed);
            Assert.Empty(BookmarkOf(runId).Isolate);
        }

        [Fact]
        public void A_repeated_stand_in_report_counts_one_failed_batch()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz2, _zz3 });
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 3 }, executor: BulkExecutor(new BulkSender()));

            processor.Process(runId, RunPageProcessor.StandIn(_zz1), "ignored");
            processor.Process(runId, RunPageProcessor.StandIn(_zz1), "ignored");

            var bookmark = BookmarkOf(runId);
            Assert.Equal(new[] { _zz1 }, bookmark.Isolate);
            Assert.Equal(1, bookmark.BatchFailures);
            Assert.False(bookmark.SingleWrites);
        }

        [Fact]
        public void Two_failed_batches_do_not_switch_the_run_to_single_writes()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz2, _zz3 });
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 3 }, executor: BulkExecutor(new BulkSender()));

            processor.Process(runId, RunPageProcessor.StandIn(_zz1), "ignored");
            processor.Process(runId, RunPageProcessor.StandIn(_zz3), "ignored");

            Assert.Equal(2, BookmarkOf(runId).BatchFailures);
            Assert.False(BookmarkOf(runId).SingleWrites);
        }

        [Fact]
        public void A_given_records_stand_in_is_recognised_from_the_run_s_ids_without_reading_the_rule_or_records()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz2, _zz3 });
            var counting = new CountingOrganizationService(_service);

            var result = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 3 }, counting, executor: BulkExecutor(new BulkSender()))
                .Process(runId, RunPageProcessor.StandIn(_zz1), "ignored");

            Assert.Equal(0, result.Evaluated + result.Failed);
            Assert.Equal(new[] { _zz1 }, BookmarkOf(runId).Isolate);
            Assert.Empty(counting.RetrieveMultipleByTable);
        }

        [Fact]
        public void A_record_failed_report_for_a_listed_record_is_never_a_stand_in()
        {
            // The run lists a record whose id happens to be another listed record's stand-in, and that
            // record no longer exists: its report is still a record's report, counted Failed.
            var listed = RunPageProcessor.StandIn(_zz1);
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, listed });

            var result = Processor(executor: BulkExecutor(new BulkSender())).Process(runId, listed, "boom");

            Assert.Equal(1, result.Failed);
            Assert.Empty(BookmarkOf(runId).Isolate);
            Assert.Equal(0, BookmarkOf(runId).BatchFailures);
            Assert.Contains(FailuresOf(Run(runId)), f => f.RecordId == listed && f.Kind == "Failed");
        }

        [Fact]
        public void A_group_whose_stand_in_was_counted_as_a_record_writes_one_record_at_a_time()
        {
            // Defence in depth: a stand-in once taken for a record sits in the skip list. Batching the
            // group again would only report the same stand-in; writing per record reports the real one.
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz2, _zz3 });
            var bookmark = new RunBookmark();
            bookmark.Skip.Add(RunPageProcessor.StandIn(_zz1));
            _service.Update(new Entity(Q(SchemaNames.RuleRun.Entity), runId) { [Q(SchemaNames.RuleRun.Bookmark)] = RunState.WriteBookmark(bookmark) });
            var sender = new BulkSender { FailOn = _zz3 };
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 3 }, executor: BulkExecutor(sender));

            var real = Assert.Throws<InvalidPluginExecutionException>(() => processor.Process(runId, null, null));

            Assert.StartsWith(RunPageProcessor.RecordFailedPrefix + _zz3 + ":", real.Message);
            Assert.Empty(sender.Sent.OfType<UpdateMultipleRequest>());
        }

        [Fact]
        public void An_all_records_run_batches_its_groups_and_resumes_a_budget_cut_page_through_the_skip_list()
        {
            // Four more ZZ accounts that sort first, so the first two groups of two are known and batch.
            var first = Enumerable.Range(1, 4).Select(OrderedId).ToList();
            foreach (var id in first)
                _service.Create(new Entity("account", id) { ["name"] = "ZZ" + id, ["numberofemployees"] = 50 });
            var runId = SeedRun(OnDemandScope.AllRecords);
            var now = Now;
            var sender = new BulkSender { OnSend = () => now = now.AddMinutes(5) };   // each send ends the page's budget
            var processor = Processor(new RunPageLimits { PageSize = 10, ChunkSize = 2 }, clock: () => now, executor: BulkExecutor(sender));

            processor.Process(runId, null, null);
            Assert.Equal(first.Take(2), BookmarkOf(runId).Skip);

            var (last, calls) = ProcessUntilDone(processor, runId);

            Assert.True(calls >= 2);
            Assert.Equal(RuleRunStatus.CompletedWithFailures, last.Status);
            Assert.Equal(8, last.Evaluated);
            Assert.Equal(6, last.Changed);
            Assert.Equal(1, last.Blocked);
            Assert.Equal(1, last.Skipped);
            Assert.Equal(0, last.Failed);
            var bulk = sender.Sent.OfType<UpdateMultipleRequest>().ToList();
            Assert.Equal(first.Take(2), bulk[0].Targets.Entities.Select(e => e.Id));
            Assert.Equal(first.Skip(2), bulk[1].Targets.Entities.Select(e => e.Id));
            var targets = sender.Sent.SelectMany(r => r is UpdateMultipleRequest m ? m.Targets.Entities.ToList()
                : r is UpdateRequest u ? new List<Entity> { u.Target } : new List<Entity>()).Select(e => e.Id).ToList();
            foreach (var id in first.Concat(new[] { _zz1, _zz3 }))
                Assert.Equal(1, targets.Count(t => t == id));
            Assert.Empty(BookmarkOf(runId).Skip);
            Assert.Empty(BookmarkOf(runId).Isolate);
            Assert.Equal(0, BookmarkOf(runId).BatchFailures);
        }

        [Fact]
        public void The_stand_in_round_trips_and_is_never_the_record_id()
        {
            var id = Guid.NewGuid();
            Assert.NotEqual(id, RunPageProcessor.StandIn(id));
            Assert.Equal(id, RunPageProcessor.StandIn(RunPageProcessor.StandIn(id)));
        }

        [Fact]
        public void A_page_of_several_groups_loads_its_rule_once()
        {
            // Rule reads for a page of one group are the baseline; three groups of one record
            // (ChunkSize = 1) on one page must read the rule no more often.
            int RuleReads(IEnumerable<Guid> ids)
            {
                var counting = new CountingOrganizationService(_service);
                var runId = SeedRun(OnDemandScope.GivenRecord, ids);
                var result = Processor(new RunPageLimits { PageSize = 10, ChunkSize = 1 }, counting).Process(runId, null, null);
                Assert.True(result.Done);
                return counting.Count(Q(SchemaNames.Rule.Entity));
            }

            var oneGroup = RuleReads(new[] { _zz1 });
            var threeGroups = RuleReads(new[] { _zz1, _zz2, _zz3 });

            Assert.Equal(oneGroup, threeGroups);
        }

        [Fact]
        public void A_failure_report_page_counts_one_failed_record_and_no_chunks()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1 });
            var diag = new RunDiagnostics();
            var processor = new RunPageProcessor(_service, _service, 1033, new XrmFakedTracingService(), engineInitiated: false,
                Limits(), () => Now, diag);

            processor.Process(runId, _zz1, "boom");

            Assert.Equal(1, diag.PageRecords);
            Assert.Equal(1, diag.PageFailed);
            Assert.Equal(0, diag.PageChunks);
            Assert.Contains(diag.Stages, s => s.Name == "bookmark");
            Assert.DoesNotContain(diag.Stages, s => s.Name == "pageSelect");
        }

        [Fact]
        public void An_all_records_run_pages_through_the_table_and_counts_each_outcome()
        {
            var runId = SeedRun(OnDemandScope.AllRecords);

            var (last, calls) = ProcessUntilDone(Processor(), runId);

            Assert.True(calls >= 2);
            Assert.Equal(RuleRunStatus.CompletedWithFailures, last.Status);
            Assert.Equal(4, last.Evaluated);
            Assert.Equal(2, last.Changed);
            Assert.Equal(1, last.Blocked);
            Assert.Equal(1, last.Skipped);
            Assert.Equal(0, last.Failed);

            var run = Run(runId);
            Assert.Equal(RuleRunStatus.CompletedWithFailures, StatusOf(run));
            Assert.Equal(4, Count(run, SchemaNames.RuleRun.Evaluated));
            Assert.Equal(2, Count(run, SchemaNames.RuleRun.Changed));
            Assert.Equal(1, Count(run, SchemaNames.RuleRun.Blocked));
            Assert.Equal(1, Count(run, SchemaNames.RuleRun.Skipped));
            Assert.Equal(0, Count(run, SchemaNames.RuleRun.Failed));
            Assert.Equal(Now, run.GetAttributeValue<DateTime>(Q(SchemaNames.RuleRun.FinishedOn)));

            var failure = Assert.Single(FailuresOf(run));
            Assert.Equal(_zz2, failure.RecordId);
            Assert.Equal("Blocked", failure.Kind);
            Assert.Contains("too small", failure.Message);

            Assert.Equal("big", Description(_zz1));
            Assert.Equal("big", Description(_zz3));
            Assert.Null(Description(_zz2));
            Assert.Null(Description(_other));
        }

        [Fact]
        public void A_given_records_run_processes_only_its_records_in_order()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz3, _zz1 });

            var (last, _) = ProcessUntilDone(Processor(), runId);

            Assert.Equal(RuleRunStatus.Completed, last.Status);
            Assert.Equal(2, last.Evaluated);
            Assert.Equal(2, last.Changed);
            Assert.Equal(0, last.Blocked + last.Failed + last.Skipped);
            Assert.Equal(RuleRunStatus.Completed, StatusOf(Run(runId)));
            Assert.Equal("big", Description(_zz1));
            Assert.Equal("big", Description(_zz3));
            Assert.Null(Description(_zz2));
            Assert.Null(Description(_other));
        }

        [Fact]
        public void A_record_deleted_after_selection_counts_as_failed_and_the_run_continues()
        {
            var deletedId = Guid.NewGuid();
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, deletedId, _zz3 });

            var (last, _) = ProcessUntilDone(Processor(), runId);

            Assert.Equal(RuleRunStatus.CompletedWithFailures, last.Status);
            Assert.Equal(3, last.Evaluated);
            Assert.Equal(1, last.Failed);
            Assert.Equal(2, last.Changed);
            var failure = Assert.Single(FailuresOf(Run(runId)));
            Assert.Equal(deletedId, failure.RecordId);
            Assert.Equal("Failed", failure.Kind);
            Assert.Equal("Record not found or not readable.", failure.Message);
            Assert.Equal("big", Description(_zz3));
        }

        [Fact]
        public void A_record_the_starter_cannot_read_counts_failed_and_is_never_evaluated_or_written()
        {
            // The rule runs in the User context: the starter's service can't see ZZ3.
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz3 });
            var user = new HiddenRowService(_service, _zz3);

            var (last, _) = ProcessUntilDone(Processor(user: user), runId);

            Assert.Equal(RuleRunStatus.CompletedWithFailures, last.Status);
            Assert.Equal(2, last.Evaluated);
            Assert.Equal(1, last.Changed);
            Assert.Equal(1, last.Failed);
            Assert.Equal(0, last.Skipped + last.Blocked);
            var failure = Assert.Single(FailuresOf(Run(runId)));
            Assert.Equal(_zz3, failure.RecordId);
            Assert.Equal("Failed", failure.Kind);
            Assert.Equal("Record not found or not readable.", failure.Message);
            Assert.Equal("big", Description(_zz1));
            Assert.Null(Description(_zz3));
        }

        [Fact]
        public void An_all_records_user_context_run_never_enumerates_a_row_the_starter_cannot_read()
        {
            var runId = SeedRun(OnDemandScope.AllRecords);
            var user = new HiddenRowService(_service, _zz3);

            var (last, _) = ProcessUntilDone(Processor(user: user), runId);

            Assert.Equal(3, last.Evaluated);
            Assert.Equal(1, last.Changed);
            Assert.Equal(1, last.Blocked);
            Assert.Equal(1, last.Skipped);
            Assert.Equal(0, last.Failed);
            Assert.DoesNotContain(FailuresOf(Run(runId)), f => f.RecordId == _zz3);
            Assert.Equal("big", Description(_zz1));
            Assert.Null(Description(_zz3));
        }

        [Fact]
        public void A_write_failure_throws_the_record_failed_message()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz3 });
            var proxy = new ProxyService(_service) { OnExecute = ThrowOnUpdateOf(_zz3) };

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                Processor(service: proxy).Process(runId, null, null));

            Assert.StartsWith("asx_ProcessRunPage:record-failed:" + _zz3, ex.Message);
            Assert.EndsWith($":Update account (action \"{_updateActionId}\"): boom", ex.Message);
            // Nothing saved: the page rolls back on the platform, and the run row was not updated.
            Assert.Equal(RuleRunStatus.Queued, StatusOf(Run(runId)));
        }

        [Fact]
        public void A_reported_failure_is_counted_once_and_skipped()
        {
            // ZZ3 is reported failed, and the report is repeated: it is counted once, stays in the
            // bookmark's skip list, and is never written when the page is then processed.
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz3, _zz2 });
            var proxy = new ProxyService(_service) { OnExecute = ThrowOnUpdateOf(_zz3) };
            var processor = Processor(service: proxy);

            var first = processor.Process(runId, _zz3, "boom");
            Assert.False(first.Done);
            Assert.Equal(1, first.Failed);
            Assert.Contains(_zz3, RunState.ParseBookmark(Run(runId).GetAttributeValue<string>(Q(SchemaNames.RuleRun.Bookmark))).Skip);

            var second = processor.Process(runId, _zz3, "boom");
            Assert.False(second.Done);
            Assert.Equal(1, second.Evaluated);
            Assert.Equal(1, second.Failed);

            var (last, _) = ProcessUntilDone(processor, runId);

            Assert.Equal(RuleRunStatus.CompletedWithFailures, last.Status);
            Assert.Equal(3, last.Evaluated);
            Assert.Equal(1, last.Failed);
            Assert.Equal(1, last.Changed);
            Assert.Equal(1, last.Blocked);
            Assert.Null(Description(_zz3));
            Assert.Equal("big", Description(_zz1));

            var failures = FailuresOf(Run(runId));
            var reported = Assert.Single(failures, f => f.RecordId == _zz3);
            Assert.Equal("Failed", reported.Kind);
            Assert.Equal("boom", reported.Message);
        }

        [Fact]
        public void A_call_that_reports_a_failure_processes_no_records()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz3 });
            var proxy = new ProxyService(_service)
            {
                OnExecute = request =>
                {
                    if (request is UpdateRequest u && u.Target.LogicalName == "account")
                        throw new InvalidOperationException("No record may be written in a call that reports a failure.");
                }
            };

            var result = Processor(service: proxy).Process(runId, _zz3, "boom");

            Assert.False(result.Done);
            Assert.Equal(RuleRunStatus.Running, result.Status);
            Assert.Equal(1, result.Evaluated);
            Assert.Equal(1, result.Failed);
            Assert.Equal(0, result.Changed + result.Blocked + result.Skipped);
            var run = Run(runId);
            Assert.Equal(1, Count(run, SchemaNames.RuleRun.Evaluated));
            Assert.Equal(Now, run.GetAttributeValue<DateTime>(Q(SchemaNames.RuleRun.LastPageOn)));
            var bookmark = RunState.ParseBookmark(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.Bookmark)));
            Assert.Equal(0, bookmark.Index);
            Assert.Equal(new[] { _zz3 }, bookmark.Skip);
            Assert.Null(Description(_zz1));
        }

        [Fact]
        public void Two_failing_writes_on_one_page_are_each_recorded_once_and_the_run_completes()
        {
            var zz4 = _service.Create(new Entity("account") { ["name"] = "ZZ4", ["numberofemployees"] = 80 });
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, zz4, _zz3, _zz2 });
            var proxy = new ProxyService(_service)
            {
                OnExecute = request => { ThrowOnUpdateOf(_zz1)(request); ThrowOnUpdateOf(_zz3)(request); }
            };
            var processor = Processor(new RunPageLimits { PageSize = 4, ChunkSize = 1 }, proxy);

            // The driver loop: on record-failed, re-call once with that record reported.
            RunPageResult result = null;
            Guid? failedId = null;
            string failedMessage = null;
            var calls = 0;
            while (calls < 10)
            {
                calls++;
                try
                {
                    result = processor.Process(runId, failedId, failedMessage);
                    failedId = null;
                    failedMessage = null;
                    if (result.Done) break;
                }
                catch (InvalidPluginExecutionException ex) when (ex.Message.StartsWith(RunPageProcessor.RecordFailedPrefix))
                {
                    var rest = ex.Message.Substring(RunPageProcessor.RecordFailedPrefix.Length);
                    failedId = Guid.Parse(rest.Substring(0, 36));
                    failedMessage = rest.Substring(37);
                }
            }

            Assert.True(calls < 10);
            Assert.True(result.Done);
            Assert.Equal(RuleRunStatus.CompletedWithFailures, result.Status);
            Assert.Equal(4, result.Evaluated);
            Assert.Equal(2, result.Failed);
            Assert.Equal(1, result.Changed);
            Assert.Equal(1, result.Blocked);
            Assert.Equal("big", Description(zz4));
            Assert.Null(Description(_zz1));
            Assert.Null(Description(_zz3));

            var failures = FailuresOf(Run(runId));
            Assert.Equal($"Update account (action \"{_updateActionId}\"): boom", Assert.Single(failures, f => f.RecordId == _zz1).Message);
            Assert.Equal($"Update account (action \"{_updateActionId}\"): boom", Assert.Single(failures, f => f.RecordId == _zz3).Message);
            Assert.Single(failures, f => f.RecordId == _zz2 && f.Kind == "Blocked");
        }

        [Fact]
        public void A_budget_cut_all_records_page_resumes_by_id_when_rows_are_deleted_or_inserted()
        {
            // Replace the seeded accounts with ids whose order is known: 10, 20, 30 | 40, 50.
            foreach (var seeded in new[] { _zz1, _zz2, _zz3, _other }) _service.Delete("account", seeded);
            foreach (var n in new[] { 10, 20, 30, 40, 50 })
                _service.Create(new Entity("account", OrderedId(n)) { ["name"] = "ZZ" + n, ["numberofemployees"] = 50 });
            var runId = SeedRun(OnDemandScope.AllRecords);
            var (proxy, writes, clock) = BudgetCutProxy();
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 1 }, proxy, clock);

            var first = processor.Process(runId, null, null);

            Assert.False(first.Done);
            Assert.Equal(1, first.Evaluated);
            var bookmark = BookmarkOf(runId);
            Assert.Equal(1, bookmark.Page);
            Assert.Equal(0, bookmark.Offset);
            Assert.Equal(new[] { OrderedId(10) }, bookmark.Skip);

            // A processed row is deleted and a new row lands inside the page: re-read by position,
            // the page would shift and skip 20 (or repeat a record).
            _service.Delete("account", OrderedId(10));
            _service.Create(new Entity("account", OrderedId(25)) { ["name"] = "ZZ25", ["numberofemployees"] = 50 });

            var second = processor.Process(runId, null, null);

            Assert.False(second.Done);
            bookmark = BookmarkOf(runId);
            Assert.Equal(1, bookmark.Page);
            Assert.Equal(new[] { OrderedId(10), OrderedId(20) }, bookmark.Skip);

            var (last, _) = ProcessUntilDone(processor, runId);

            Assert.Equal(RuleRunStatus.Completed, last.Status);
            Assert.Equal(6, last.Evaluated);
            Assert.Equal(6, last.Changed);
            Assert.Equal(0, last.Failed + last.Blocked + last.Skipped);
            var expected = new[] { 10, 20, 25, 30, 40, 50 }.Select(OrderedId).ToList();
            Assert.Equal(expected.OrderBy(id => id), writes.Keys.OrderBy(id => id));
            Assert.All(writes.Values, count => Assert.Equal(1, count));
        }

        [Fact]
        public void A_budget_cut_given_records_page_advances_the_index_by_what_it_consumed()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz3, _zz2 });
            var (proxy, writes, clock) = BudgetCutProxy();
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 1 }, proxy, clock);

            var first = processor.Process(runId, null, null);

            Assert.False(first.Done);
            var bookmark = BookmarkOf(runId);
            Assert.Equal(1, bookmark.Index);
            Assert.Empty(bookmark.Skip);

            var (last, _) = ProcessUntilDone(processor, runId);

            Assert.Equal(RuleRunStatus.CompletedWithFailures, last.Status);
            Assert.Equal(3, last.Evaluated);
            Assert.Equal(2, last.Changed);
            Assert.Equal(1, last.Blocked);
            Assert.Equal(0, last.Failed + last.Skipped);
            Assert.Equal(3, BookmarkOf(runId).Index);
            Assert.All(writes.Values, count => Assert.Equal(1, count));
            Assert.Equal(2, writes.Count);
        }

        [Fact]
        public void The_default_page_limits_leave_headroom_under_the_platform_timeout()
        {
            var limits = new RunPageLimits();

            Assert.Equal(TimeSpan.FromSeconds(60), limits.Budget);
            Assert.Equal(25, limits.ChunkSize);
        }

        [Fact]
        public void A_budget_cut_inside_a_given_records_chunk_stops_after_the_current_record()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz3, _zz2 });
            var (proxy, writes, clock) = BudgetCutProxy();
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 3 }, proxy, clock);

            var first = processor.Process(runId, null, null);

            Assert.False(first.Done);
            Assert.Equal(1, first.Evaluated);
            Assert.Equal(1, first.Changed);
            Assert.Equal(1, BookmarkOf(runId).Index);
            Assert.Null(Description(_zz3));

            var (last, _) = ProcessUntilDone(processor, runId);

            Assert.Equal(RuleRunStatus.CompletedWithFailures, last.Status);
            Assert.Equal(3, last.Evaluated);
            Assert.Equal(2, last.Changed);
            Assert.Equal(1, last.Blocked);
            Assert.Equal(0, last.Failed + last.Skipped);
            Assert.Equal(2, writes.Count);
            Assert.All(writes.Values, count => Assert.Equal(1, count));
        }

        [Fact]
        public void A_budget_cut_inside_a_chunk_keeps_an_already_counted_missing_record_counted_once()
        {
            var missing = Guid.NewGuid();
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, missing, _zz3 });
            var (proxy, writes, clock) = BudgetCutProxy();
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 3 }, proxy, clock);

            var first = processor.Process(runId, null, null);

            Assert.False(first.Done);
            Assert.Equal(2, first.Evaluated);   // ZZ1 written, the missing id counted
            Assert.Equal(1, first.Failed);

            var (last, _) = ProcessUntilDone(processor, runId);

            Assert.Equal(RuleRunStatus.CompletedWithFailures, last.Status);
            Assert.Equal(3, last.Evaluated);
            Assert.Equal(1, last.Failed);
            Assert.Equal(2, last.Changed);
            Assert.Single(FailuresOf(Run(runId)), f => f.RecordId == missing);
            Assert.All(writes.Values, count => Assert.Equal(1, count));
        }

        [Fact]
        public void A_budget_cut_inside_an_all_records_chunk_skips_only_what_it_handled()
        {
            foreach (var seeded in new[] { _zz1, _zz2, _zz3, _other }) _service.Delete("account", seeded);
            foreach (var n in new[] { 10, 20, 30 })
                _service.Create(new Entity("account", OrderedId(n)) { ["name"] = "ZZ" + n, ["numberofemployees"] = 50 });
            var runId = SeedRun(OnDemandScope.AllRecords);
            var (proxy, writes, clock) = BudgetCutProxy();
            var processor = Processor(new RunPageLimits { PageSize = 3, ChunkSize = 3 }, proxy, clock);

            var first = processor.Process(runId, null, null);

            Assert.False(first.Done);
            Assert.Equal(1, first.Evaluated);
            var bookmark = BookmarkOf(runId);
            Assert.Equal(1, bookmark.Page);
            Assert.Equal(new[] { OrderedId(10) }, bookmark.Skip);

            var (last, _) = ProcessUntilDone(processor, runId);

            Assert.Equal(RuleRunStatus.Completed, last.Status);
            Assert.Equal(3, last.Evaluated);
            Assert.Equal(3, last.Changed);
            Assert.Equal(3, writes.Count);
            Assert.All(writes.Values, count => Assert.Equal(1, count));
        }

        [Fact]
        public void A_long_reported_failure_message_is_stored_cut_to_1000_characters()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1 });

            Processor().Process(runId, _zz1, new string('m', 5000));

            var failure = Assert.Single(FailuresOf(Run(runId)));
            Assert.Equal(new string('m', 1000), failure.Message);
        }

        [Fact]
        public void A_long_write_error_is_stored_cut_to_1000_characters()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1 });
            var proxy = new ProxyService(_service)
            {
                OnExecute = request =>
                {
                    if (request is UpdateRequest u && u.Target.LogicalName == "account")
                        throw new InvalidPluginExecutionException(new string('w', 5000));
                }
            };
            var processor = Processor(service: proxy);

            // The driver passes the record-failed message back as FailedMessage.
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => processor.Process(runId, null, null));
            var message = ex.Message.Substring(RunPageProcessor.RecordFailedPrefix.Length + 37);
            processor.Process(runId, _zz1, message);

            var failure = Assert.Single(FailuresOf(Run(runId)));
            Assert.Equal(_zz1, failure.RecordId);
            Assert.Equal(($"Update account (action \"{_updateActionId}\"): " + new string('w', 5000)).Substring(0, 1000), failure.Message);
        }

        [Fact]
        public void The_safety_stop_fails_a_run_whose_first_records_all_fail()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { Guid.NewGuid(), Guid.NewGuid(), _zz1 });
            var limits = new RunPageLimits { PageSize = 10, ChunkSize = 1, SafetyStopAfter = 2 };

            var result = Processor(limits).Process(runId, null, null);

            Assert.True(result.Done);
            Assert.Equal(RuleRunStatus.Failed, result.Status);
            Assert.Equal(2, result.Evaluated);
            Assert.Equal(2, result.Failed);
            var run = Run(runId);
            Assert.Equal(RuleRunStatus.Failed, StatusOf(run));
            Assert.Equal(Now, run.GetAttributeValue<DateTime>(Q(SchemaNames.RuleRun.FinishedOn)));
            Assert.Null(Description(_zz1));
        }

        [Fact]
        public void A_cancelled_run_does_nothing()
        {
            var runId = SeedRun(OnDemandScope.AllRecords, status: RuleRunStatus.Cancelled);

            var result = Processor().Process(runId, null, null);

            Assert.True(result.Done);
            Assert.Equal(RuleRunStatus.Cancelled, result.Status);
            Assert.Equal(0, result.Evaluated);
            var run = Run(runId);
            Assert.Equal(RuleRunStatus.Cancelled, StatusOf(run));
            Assert.Equal(0, Count(run, SchemaNames.RuleRun.Evaluated));
            Assert.False(run.Contains(Q(SchemaNames.RuleRun.LastPageOn)));
            Assert.Null(Description(_zz1));
        }

        [Fact]
        public void Cancelling_during_a_page_is_kept()
        {
            var runId = SeedRun(OnDemandScope.AllRecords);
            // The cancel-guard re-read (status only) sees a cancel that landed during the page.
            var proxy = new ProxyService(_service)
            {
                OnRetrieve = (entity, id, columns) =>
                {
                    if (entity == Q(SchemaNames.RuleRun.Entity) && !columns.AllColumns)
                        _service.Update(new Entity(entity, id) { [Q(SchemaNames.RuleRun.Status)] = new OptionSetValue((int)RuleRunStatus.Cancelled) });
                }
            };

            var result = Processor(service: proxy).Process(runId, null, null);

            Assert.True(result.Done);
            Assert.Equal(RuleRunStatus.Cancelled, result.Status);
            var run = Run(runId);
            Assert.Equal(RuleRunStatus.Cancelled, StatusOf(run));
            Assert.Equal(result.Evaluated, Count(run, SchemaNames.RuleRun.Evaluated));
            Assert.Equal(2, result.Evaluated);
            Assert.False(string.IsNullOrEmpty(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.Bookmark))));
        }

        [Fact]
        public void A_page_locks_the_run_row_with_an_update_before_reading_its_state()
        {
            // Two drivers on one run serialize on this update's row lock (it holds until the page's
            // transaction ends), and a cancel waits for the page instead of racing its save.
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz3 });
            var runEntity = Q(SchemaNames.RuleRun.Entity);
            var calls = new List<string>();
            Entity lockUpdate = null;
            var proxy = new ProxyService(_service)
            {
                OnRetrieve = (entity, id, columns) => { if (entity == runEntity) calls.Add("Retrieve"); },
                OnUpdate = entity =>
                {
                    if (entity.LogicalName != runEntity) return;
                    calls.Add("Update");
                    if (lockUpdate == null) lockUpdate = entity;
                },
                OnExecute = request =>
                {
                    if (request is RetrieveRequest r && r.Target.LogicalName == runEntity) calls.Add("Retrieve");
                    if (request is UpdateRequest u && u.Target.LogicalName == runEntity) calls.Add("Update");
                },
            };

            Processor(service: proxy).Process(runId, null, null);

            Assert.True(calls.Count >= 3);
            Assert.Equal("Retrieve", calls[0]);   // the status check
            Assert.Equal("Update", calls[1]);     // the row lock, before the bookmark is read
            Assert.Equal("Retrieve", calls[2]);   // the state the page works from
            Assert.Equal(new[] { Q(SchemaNames.RuleRun.LastPageOn) }, lockUpdate.Attributes.Keys.ToArray());
        }

        [Fact]
        public void A_run_that_finished_before_the_lock_is_reported_as_it_stands()
        {
            // Another driver completed the run between this call's status check and its lock.
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1 });
            var runEntity = Q(SchemaNames.RuleRun.Entity);
            var proxy = new ProxyService(_service)
            {
                OnUpdate = entity =>
                {
                    if (entity.LogicalName == runEntity && entity.Contains(Q(SchemaNames.RuleRun.LastPageOn))
                        && !entity.Contains(Q(SchemaNames.RuleRun.Status)))
                        _service.Update(new Entity(runEntity, runId) { [Q(SchemaNames.RuleRun.Status)] = new OptionSetValue((int)RuleRunStatus.Completed) });
                },
            };

            var result = Processor(service: proxy).Process(runId, null, null);

            Assert.True(result.Done);
            Assert.Equal(RuleRunStatus.Completed, result.Status);
            Assert.Equal(0, result.Evaluated);
            Assert.Null(Description(_zz1));
        }

        [Fact]
        public void A_rule_unpublished_mid_run_fails_the_run()
        {
            var runId = SeedRun(OnDemandScope.AllRecords);
            var processor = Processor();
            Assert.False(processor.Process(runId, null, null).Done);

            _service.Update(new Entity(Q(SchemaNames.Rule.Entity), _ruleId) { ["statuscode"] = new OptionSetValue((int)RuleStatus.Draft) });
            var result = processor.Process(runId, null, null);

            Assert.True(result.Done);
            Assert.Equal(RuleRunStatus.Failed, result.Status);
            var run = Run(runId);
            Assert.Equal(RuleRunStatus.Failed, StatusOf(run));
            Assert.Equal(Now, run.GetAttributeValue<DateTime>(Q(SchemaNames.RuleRun.FinishedOn)));
            var failure = Assert.Single(FailuresOf(run), f => f.RecordId == Guid.Empty);
            Assert.Equal("Failed", failure.Kind);
            Assert.Equal("The rule is no longer published with the On demand trigger.", failure.Message);
        }

        [Fact]
        public void An_all_records_run_fails_once_its_rule_runs_for_given_records()
        {
            var runId = SeedRun(OnDemandScope.AllRecords);
            _service.Update(new Entity(Q(SchemaNames.Rule.Entity), _ruleId)
            {
                [Q(SchemaNames.Rule.OnDemandScope)] = new OptionSetValue((int)OnDemandScope.GivenRecord),
            });
            Publish(Guid.NewGuid());

            var result = Processor().Process(runId, null, null);

            AssertScopeMismatch(runId, result);
        }

        [Fact]
        public void An_all_records_run_with_record_ids_fails()
        {
            var runId = SeedRun(OnDemandScope.AllRecords, new[] { _zz1 });

            var result = Processor().Process(runId, null, null);

            AssertScopeMismatch(runId, result);
        }

        [Fact]
        public void A_given_records_run_without_record_ids_fails()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord);

            var result = Processor().Process(runId, null, null);

            AssertScopeMismatch(runId, result);
        }

        private void AssertScopeMismatch(Guid runId, RunPageResult result)
        {
            Assert.True(result.Done);
            Assert.Equal(RuleRunStatus.Failed, result.Status);
            Assert.Equal(0, result.Evaluated);
            var run = Run(runId);
            Assert.Equal(RuleRunStatus.Failed, StatusOf(run));
            var failure = Assert.Single(FailuresOf(run));
            Assert.Equal(Guid.Empty, failure.RecordId);
            Assert.Equal("The run no longer matches its rule's Runs for setting.", failure.Message);
            Assert.Null(Description(_zz1));
        }

        [Fact]
        public void Republishing_mid_run_records_a_second_version_and_the_next_page_uses_it()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz3 });
            var processor = Processor(new RunPageLimits { PageSize = 1, ChunkSize = 1 });
            Assert.False(processor.Process(runId, null, null).Done);

            _service.Update(new Entity(Q(SchemaNames.RuleAction.Entity), _updateActionId)
            {
                [Q(SchemaNames.RuleAction.FieldMapping)] = "[{\"target\":\"description\",\"source\":\"literal\",\"value\":\"bigger\"}]",
            });
            var secondRevision = Guid.NewGuid();
            Publish(secondRevision);

            var (last, _) = ProcessUntilDone(processor, runId);

            Assert.Equal(RuleRunStatus.Completed, last.Status);
            Assert.Equal("big", Description(_zz1));
            Assert.Equal("bigger", Description(_zz3));
            Assert.Equal(new[] { _revisionId, secondRevision },
                RunState.ParseVersions(Run(runId).GetAttributeValue<string>(Q(SchemaNames.RuleRun.RuleVersions))));
        }

        [Fact]
        public void A_failure_after_a_success_does_not_trip_the_safety_stop()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() });
            var limits = new RunPageLimits { PageSize = 10, ChunkSize = 1, SafetyStopAfter = 2 };

            var (last, _) = ProcessUntilDone(Processor(limits), runId);

            Assert.Equal(RuleRunStatus.CompletedWithFailures, last.Status);
            Assert.Equal(4, last.Evaluated);
            Assert.Equal(3, last.Failed);
            Assert.Equal(1, last.Changed);
        }

        [Fact]
        public void The_first_page_marks_the_run_running_and_records_the_rule_version()
        {
            var runId = SeedRun(OnDemandScope.AllRecords);

            var result = Processor().Process(runId, null, null);

            Assert.False(result.Done);
            Assert.Equal(RuleRunStatus.Running, result.Status);
            Assert.Equal(2, result.Evaluated);
            var run = Run(runId);
            Assert.Equal(RuleRunStatus.Running, StatusOf(run));
            Assert.Equal(Now, run.GetAttributeValue<DateTime>(Q(SchemaNames.RuleRun.LastPageOn)));
            Assert.False(run.Contains(Q(SchemaNames.RuleRun.FinishedOn)));
            Assert.Equal(new[] { _revisionId }, RunState.ParseVersions(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.RuleVersions))));
            Assert.Equal(2, RunState.ParseBookmark(run.GetAttributeValue<string>(Q(SchemaNames.RuleRun.Bookmark))).Page);        }

        [Fact]
        public void The_api_writes_the_page_result_to_its_outputs()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1 });
            var pctx = new XrmFakedPluginExecutionContext
            {
                MessageName = SchemaNames.ProcessRunPageApi.MessageName,
                Stage = 30,
                InputParameters = new ParameterCollection { { SchemaNames.ProcessRunPageApi.ParamRunId, runId } },
                OutputParameters = new ParameterCollection()
            };

            _ctx.ExecutePluginWith<ProcessRunPageApi>(pctx);

            Assert.True((bool)pctx.OutputParameters[SchemaNames.ProcessRunPageApi.PropDone]);
            Assert.Equal((int)RuleRunStatus.Completed, (int)pctx.OutputParameters[SchemaNames.ProcessRunPageApi.PropStatus]);
            Assert.Equal(1, (int)pctx.OutputParameters[SchemaNames.ProcessRunPageApi.PropEvaluated]);
            Assert.Equal(1, (int)pctx.OutputParameters[SchemaNames.ProcessRunPageApi.PropChanged]);
            Assert.Equal(0, (int)pctx.OutputParameters[SchemaNames.ProcessRunPageApi.PropBlocked]);
            Assert.Equal(0, (int)pctx.OutputParameters[SchemaNames.ProcessRunPageApi.PropFailed]);
            Assert.Equal(0, (int)pctx.OutputParameters[SchemaNames.ProcessRunPageApi.PropSkipped]);
            Assert.False(pctx.OutputParameters.ContainsKey(SchemaNames.ProcessRunPageApi.PropDiagnostics));
        }

        [Fact]
        public void With_IncludeDiagnostics_the_page_api_returns_page_diagnostics()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1 });
            var pctx = new XrmFakedPluginExecutionContext
            {
                MessageName = SchemaNames.ProcessRunPageApi.MessageName,
                Stage = 30,
                InputParameters = new ParameterCollection
                {
                    { SchemaNames.ProcessRunPageApi.ParamRunId, runId },
                    { SchemaNames.ProcessRunPageApi.ParamIncludeDiagnostics, true },
                },
                OutputParameters = new ParameterCollection()
            };

            _ctx.ExecutePluginWith<ProcessRunPageApi>(pctx);

            var json = (string)pctx.OutputParameters[SchemaNames.ProcessRunPageApi.PropDiagnostics];
            Assert.Contains("\"pageRecords\":1", json);
            Assert.Contains("\"pageSelect\"", json);
            Assert.Contains("\"bookmark\"", json);
            Assert.Contains("\"writesSent\":1", json);
        }

        private Action<OrganizationRequest> ThrowOnUpdateOf(Guid accountId) => request =>
        {
            if (request is UpdateRequest u && u.Target.LogicalName == "account" && u.Target.Id == accountId)
                throw new InvalidPluginExecutionException("boom");
        };

        /// <summary>Delegates to the faked service, with hooks that run before Execute and Retrieve.</summary>
        private sealed class ProxyService : IOrganizationService
        {
            private readonly IOrganizationService _inner;

            public ProxyService(IOrganizationService inner) { _inner = inner; }

            public Action<OrganizationRequest> OnExecute { get; set; }
            public Action<string, Guid, ColumnSet> OnRetrieve { get; set; }
            public Action<Entity> OnUpdate { get; set; }

            public OrganizationResponse Execute(OrganizationRequest request)
            {
                OnExecute?.Invoke(request);
                return _inner.Execute(request);
            }

            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet)
            {
                OnRetrieve?.Invoke(entityName, id, columnSet);
                return _inner.Retrieve(entityName, id, columnSet);
            }

            public Guid Create(Entity entity) => _inner.Create(entity);
            public void Update(Entity entity)
            {
                OnUpdate?.Invoke(entity);
                _inner.Update(entity);
            }

            public void Delete(string entityName, Guid id) => _inner.Delete(entityName, id);
            public EntityCollection RetrieveMultiple(QueryBase query) => _inner.RetrieveMultiple(query);
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities)
                => _inner.Associate(entityName, entityId, relationship, relatedEntities);
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities)
                => _inner.Disassociate(entityName, entityId, relationship, relatedEntities);
        }
    }
}
