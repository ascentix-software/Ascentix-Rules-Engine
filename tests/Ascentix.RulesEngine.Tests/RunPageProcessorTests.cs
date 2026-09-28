using System;
using System.Collections.Generic;
using System.Linq;
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
                },
                Group(execGroup, ruleRef, isExecutionCondition: true),
                Condition(execGroup, cfgRef, "name", ComparisonOperator.Contains, "ZZ"),
                Group(matchGroup, ruleRef, isExecutionCondition: false),
                Condition(matchGroup, cfgRef, "numberofemployees", ComparisonOperator.GreaterThan, "10"),
                new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid())
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

            // Publish: freeze the authored rows into a revision and point the rule at it.
            var snapshot = RuleSnapshot.Capture(_service, _ruleId);
            _service.Create(new Entity(Q(SchemaNames.RuleRevision.Entity), _revisionId)
            {
                [Q(SchemaNames.RuleRevision.Rule)] = ruleRef,
                [Q(SchemaNames.RuleRevision.Definition)] = snapshot.Serialize(),
                [Q(SchemaNames.RuleRevision.Hash)] = snapshot.Hash(),
            });
            _service.Update(new Entity(Q(SchemaNames.Rule.Entity), _ruleId)
            {
                [Q(SchemaNames.Rule.PublishedRevision)] = new EntityReference(Q(SchemaNames.RuleRevision.Entity), _revisionId),
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

        private RunPageProcessor Processor(RunPageLimits limits = null, IOrganizationService service = null, Func<DateTime> clock = null)
        {
            var svc = service ?? _service;
            return new RunPageProcessor(svc, svc, 1033, new XrmFakedTracingService(), engineInitiated: false,
                limits ?? Limits(), clock ?? (() => Now));
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
            Assert.Equal("Record not found.", failure.Message);
            Assert.Equal("big", Description(_zz3));
        }

        [Fact]
        public void A_write_failure_throws_the_record_failed_message()
        {
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz3 });
            var proxy = new ProxyService(_service) { OnExecute = ThrowOnUpdateOf(_zz3) };

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                Processor(service: proxy).Process(runId, null, null));

            Assert.StartsWith("asx_ProcessRunPage:record-failed:" + _zz3, ex.Message);
            Assert.EndsWith(":boom", ex.Message);
            // Nothing saved: the page rolls back on the platform, and the run row was not updated.
            Assert.Equal(RuleRunStatus.Queued, StatusOf(Run(runId)));
        }

        [Fact]
        public void A_reported_failure_is_counted_once_and_skipped()
        {
            // ZZ3 is reported failed; after ZZ1 is written the clock jumps past the budget, so the
            // page stops part-way and ZZ3 stays in the bookmark's skip list. The caller retries the
            // same report: it is not counted twice, and ZZ3 is never written.
            var runId = SeedRun(OnDemandScope.GivenRecord, new[] { _zz1, _zz3, _zz2 });
            var now = Now;
            var proxy = new ProxyService(_service)
            {
                OnExecute = request =>
                {
                    ThrowOnUpdateOf(_zz3)(request);
                    if (request is UpdateRequest u && u.Target.LogicalName == "account") now = now.AddMinutes(5);
                }
            };
            var processor = Processor(service: proxy, clock: () => now);

            var first = processor.Process(runId, _zz3, "boom");
            Assert.False(first.Done);
            Assert.Equal(1, first.Failed);
            Assert.Contains(_zz3, RunState.ParseBookmark(Run(runId).GetAttributeValue<string>(Q(SchemaNames.RuleRun.Bookmark))).Skip);

            var second = processor.Process(runId, _zz3, "boom");

            Assert.True(second.Done);
            Assert.Equal(RuleRunStatus.CompletedWithFailures, second.Status);
            Assert.Equal(3, second.Evaluated);
            Assert.Equal(1, second.Failed);
            Assert.Equal(1, second.Changed);
            Assert.Equal(1, second.Blocked);
            Assert.Null(Description(_zz3));
            Assert.Equal("big", Description(_zz1));

            var failures = FailuresOf(Run(runId));
            var reported = Assert.Single(failures, f => f.RecordId == _zz3);
            Assert.Equal("Failed", reported.Kind);
            Assert.Equal("boom", reported.Message);
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
            public void Update(Entity entity) => _inner.Update(entity);
            public void Delete(string entityName, Guid id) => _inner.Delete(entityName, id);
            public EntityCollection RetrieveMultiple(QueryBase query) => _inner.RetrieveMultiple(query);
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities)
                => _inner.Associate(entityName, entityId, relationship, relatedEntities);
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities)
                => _inner.Disassociate(entityName, entityId, relationship, relatedEntities);
        }
    }
}
