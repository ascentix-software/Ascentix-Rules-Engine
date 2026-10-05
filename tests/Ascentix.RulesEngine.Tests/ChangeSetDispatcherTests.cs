using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ChangeSetDispatcherTests
    {
        private sealed class NullTrace : ITracingService { public void Trace(string f, params object[] a) { } }

        private sealed class NamedService : IOrganizationService
        {
            public readonly string Name;
            public NamedService(string name) { Name = name; }
            public OrganizationResponse Execute(OrganizationRequest request) => throw new NotImplementedException();
            public Guid Create(Entity e) => throw new NotImplementedException();
            public void Update(Entity e) => throw new NotImplementedException();
            public void Delete(string n, Guid id) => throw new NotImplementedException();
            public Entity Retrieve(string n, Guid id, ColumnSet c) => throw new NotImplementedException();
            public EntityCollection RetrieveMultiple(QueryBase q) => throw new NotImplementedException();
            public void Associate(string n, Guid id, Relationship r, EntityReferenceCollection c) { }
            public void Disassociate(string n, Guid id, Relationship r, EntityReferenceCollection c) { }
        }

        private sealed class RecordingSender : IWriteRequestSender
        {
            public readonly List<(IOrganizationService Service, OrganizationRequest Request)> Sent = new List<(IOrganizationService, OrganizationRequest)>();
            public Func<OrganizationRequest, int, Exception> FailWith; // (request, index) → exception to throw
            public void Send(IOrganizationService service, OrganizationRequest request)
            {
                var failure = FailWith?.Invoke(request, Sent.Count);
                if (failure != null) throw failure;
                Sent.Add((service, request));
            }
        }

        private sealed class FakeSupport : IBulkWriteSupport
        {
            private readonly HashSet<string> _supported;
            public FakeSupport(params string[] supported) { _supported = new HashSet<string>(supported, StringComparer.OrdinalIgnoreCase); }
            public bool Supports(string message, string table) => _supported.Contains(message + "|" + table);
        }

        private static readonly NamedService User = new NamedService("user"), SystemService = new NamedService("system");

        private static WriteIntent Upd(string table, Guid id, string name = "Stop bulk email", RuleEvaluationContext ctx = RuleEvaluationContext.User) => new WriteIntent
        {
            Operation = WriteOperation.Update, TargetTable = table, TargetId = id, Context = ctx, SourceActionName = name,
            Values = new Dictionary<string, object> { ["donotbulkemail"] = true },
        };
        private static WriteIntent Crt(string table) => new WriteIntent
        {
            Operation = WriteOperation.Create, TargetTable = table, TargetId = Guid.NewGuid(), SourceActionName = "Follow up",
            Values = new Dictionary<string, object> { ["subject"] = "x" },
        };
        private static WriteIntent Del(string table) => new WriteIntent { Operation = WriteOperation.Delete, TargetTable = table, TargetId = Guid.NewGuid() };

        private static (ChangeSetDispatcher Dispatcher, RecordingSender Sender) Make(params string[] supported)
        {
            var sender = new RecordingSender();
            return (new ChangeSetDispatcher(new FakeSupport(supported), sender, new NullTrace()), sender);
        }

        [Fact]
        public void Two_creates_for_a_bulk_table_go_as_one_CreateMultiple_without_their_ids()
        {
            var (d, s) = Make("CreateMultiple|task");
            var a = Crt("task"); var b = Crt("task");
            Assert.Equal(2, d.SendBatches(ChangeSet.Build(new[] { a, b }), User, SystemService));
            var request = Assert.IsType<CreateMultipleRequest>(s.Sent.Single().Request);
            Assert.Equal("task", request.Targets.EntityName);
            Assert.All(request.Targets.Entities, e => Assert.Equal(Guid.Empty, e.Id));
        }

        [Fact]
        public void One_create_goes_single_even_when_the_table_supports_bulk()
        {
            var (d, s) = Make("CreateMultiple|task");
            var a = Crt("task");
            d.SendBatches(ChangeSet.Build(new[] { a }), User, SystemService);
            var request = Assert.IsType<CreateRequest>(s.Sent.Single().Request);
            Assert.Equal(Guid.Empty, request.Target.Id);
        }

        [Fact]
        public void Updates_go_in_chunks_of_100()
        {
            var (d, s) = Make("UpdateMultiple|contact");
            var intents = Enumerable.Range(0, 250).Select(_ => Upd("contact", Guid.NewGuid())).ToList();
            Assert.Equal(250, d.SendBatches(ChangeSet.Build(intents), User, SystemService));
            Assert.Equal(new[] { 100, 100, 50 }, s.Sent.Select(x => ((UpdateMultipleRequest)x.Request).Targets.Entities.Count));
        }

        [Fact]
        public void A_table_without_bulk_support_gets_single_requests()
        {
            var (d, s) = Make();
            d.SendBatches(ChangeSet.Build(new[] { Upd("contact", Guid.NewGuid()), Upd("contact", Guid.NewGuid()) }), User, SystemService);
            Assert.All(s.Sent, x => Assert.IsType<UpdateRequest>(x.Request));
            Assert.Equal(2, s.Sent.Count);
        }

        [Fact]
        public void Deletes_are_always_single()
        {
            var (d, s) = Make("DeleteMultiple|task", "UpdateMultiple|task", "CreateMultiple|task");
            d.SendBatches(ChangeSet.Build(new[] { Del("task"), Del("task") }), User, SystemService);
            Assert.All(s.Sent, x => Assert.IsType<DeleteRequest>(x.Request));
        }

        [Fact]
        public void Updates_carrying_statecode_go_single_until_UpdateMultiple_is_proven()
        {
            WriteIntent Deactivate() => new WriteIntent
            {
                Operation = WriteOperation.Update, TargetTable = "task", TargetId = Guid.NewGuid(),
                Values = new Dictionary<string, object> { ["statecode"] = new OptionSetValue(1), ["statuscode"] = new OptionSetValue(5) },
            };
            var sender = new RecordingSender();
            new ChangeSetDispatcher(new FakeSupport("UpdateMultiple|task"), sender, new NullTrace(), bulkStateChanges: false)
                .SendBatches(ChangeSet.Build(new[] { Deactivate(), Deactivate() }), User, SystemService);
            Assert.All(sender.Sent, x => Assert.IsType<UpdateRequest>(x.Request));

            var proven = new RecordingSender();
            new ChangeSetDispatcher(new FakeSupport("UpdateMultiple|task"), proven, new NullTrace(), bulkStateChanges: true)
                .SendBatches(ChangeSet.Build(new[] { Deactivate(), Deactivate() }), User, SystemService);
            Assert.IsType<UpdateMultipleRequest>(proven.Sent.Single().Request);
        }

        [Fact]
        public void Every_request_carries_the_engine_tag()
        {
            var (d, s) = Make("CreateMultiple|task", "UpdateMultiple|contact");
            d.SendBatches(ChangeSet.Build(new[]
            {
                Crt("task"), Crt("task"),
                Upd("contact", Guid.NewGuid()), Upd("contact", Guid.NewGuid()),
                Del("task"),
            }), User, SystemService);
            Assert.Contains(s.Sent, x => x.Request is CreateMultipleRequest);
            Assert.Contains(s.Sent, x => x.Request is UpdateMultipleRequest);
            Assert.Contains(s.Sent, x => x.Request is DeleteRequest);
            Assert.All(s.Sent, x => Assert.Equal(PluginReentry.EngineWriteTag, x.Request["tag"]));
        }

        [Fact]
        public void User_and_system_batches_use_their_own_services()
        {
            var (d, s) = Make();
            d.SendBatches(ChangeSet.Build(new[] { Upd("contact", Guid.NewGuid()), Upd("account", Guid.NewGuid(), ctx: RuleEvaluationContext.System) }), User, SystemService);
            Assert.Equal(new[] { "user", "system" }, s.Sent.Select(x => ((NamedService)x.Service).Name));
        }

        [Fact]
        public void A_failed_single_request_names_the_operation_table_and_action()
        {
            var (d, s) = Make();
            s.FailWith = (r, i) => new InvalidPluginExecutionException("Not allowed.");
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                d.SendBatches(ChangeSet.Build(new[] { Upd("contact", Guid.NewGuid()) }), User, SystemService));
            Assert.Equal("Update contact (action \"Stop bulk email\"): Not allowed.", ex.Message);
        }

        [Fact]
        public void A_failed_single_request_carries_no_failed_write_unless_asked()
        {
            var (d, s) = Make();
            s.FailWith = (r, i) => new InvalidPluginExecutionException("Not allowed.");
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                d.SendBatches(ChangeSet.Build(new[] { Upd("contact", Guid.NewGuid()) }), User, SystemService));
            Assert.False(ex.Data.Contains(ChangeSetDispatcher.FailedWriteKey));
        }

        [Fact]
        public void A_failed_bulk_request_names_the_message_and_table()
        {
            var (d, s) = Make("UpdateMultiple|contact");
            var inner = new InvalidPluginExecutionException("Row 12 failed.");
            s.FailWith = (r, i) => i == 1 ? inner : null; // the second chunk
            var intents = Enumerable.Range(0, 150).Select(_ => Upd("contact", Guid.NewGuid())).ToList();
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => d.SendBatches(ChangeSet.Build(intents), User, SystemService));
            Assert.Equal("UpdateMultiple contact: Row 12 failed.", ex.Message);
            Assert.Same(inner, ex.InnerException);
        }

        [Fact]
        public void Root_in_place_values_are_copied_onto_the_target_and_never_sent()
        {
            var (d, s) = Make();
            var root = Guid.NewGuid();
            var target = new Entity("account", root);
            var cs = ChangeSet.Build(new[] { new WriteIntent { Operation = WriteOperation.Update, TargetTable = "account", TargetId = root,
                RootTargeted = true, AlwaysWrite = true, Values = new Dictionary<string, object> { ["description"] = "x" } } }, new RootRecord("account", root));

            Assert.True(d.ApplyInPlace(cs, target));
            Assert.Equal(0, d.SendBatches(cs, User, SystemService));
            Assert.Equal("x", target["description"]);
            Assert.Empty(s.Sent);
        }

        private sealed class CountingService : IOrganizationService
        {
            public int Queries;
            public EntityCollection RetrieveMultiple(QueryBase q)
            {
                Queries++;
                var query = (QueryExpression)q;
                var table = (string)query.Criteria.Conditions.Single(c => c.AttributeName == "primaryobjecttypecode").Values[0];
                var message = (string)query.LinkEntities.Single().LinkCriteria.Conditions.Single().Values[0];
                return new EntityCollection(table == "task" && message == "CreateMultiple"
                    ? new List<Entity> { new Entity("sdkmessagefilter", Guid.NewGuid()) } : new List<Entity>());
            }
            public OrganizationResponse Execute(OrganizationRequest r) => throw new NotImplementedException();
            public Guid Create(Entity e) => throw new NotImplementedException();
            public void Update(Entity e) => throw new NotImplementedException();
            public void Delete(string n, Guid id) => throw new NotImplementedException();
            public Entity Retrieve(string n, Guid id, ColumnSet c) => throw new NotImplementedException();
            public void Associate(string n, Guid id, Relationship r, EntityReferenceCollection c) { }
            public void Disassociate(string n, Guid id, Relationship r, EntityReferenceCollection c) { }
        }

        [Fact]
        public void Bulk_support_is_queried_once_per_message_and_table()
        {
            var service = new CountingService();
            var support = new SdkMessageFilterBulkSupport(service);
            Assert.True(support.Supports("CreateMultiple", "task"));
            Assert.True(support.Supports("CreateMultiple", "task"));
            Assert.False(support.Supports("UpdateMultiple", "task"));
            Assert.Equal(2, service.Queries);
        }

        [Fact]
        public void Diagnostics_count_rows_and_requests_and_time_each_batch_by_operation_and_table()
        {
            var diag = new RunDiagnostics();
            var sender = new RecordingSender();
            var d = new ChangeSetDispatcher(new FakeSupport("UpdateMultiple|contact"), sender, new NullTrace(), diagnostics: diag);
            var intents = Enumerable.Range(0, 150).Select(_ => Upd("contact", Guid.NewGuid()))
                .Concat(new[] { Del("task"), Del("task") }).ToList();

            Assert.Equal(152, d.SendBatches(ChangeSet.Build(intents), User, SystemService));

            Assert.Equal(152, diag.WritesSent);
            Assert.Equal(2, diag.BulkRequests);   // 100 + 50
            Assert.Equal(2, diag.SingleRequests); // deletes are always single
            Assert.Contains(diag.Stages, s => s.Name == "dispatch:Update:contact");
            Assert.Contains(diag.Stages, s => s.Name == "dispatch:Delete:task");
        }

        [Fact]
        public void A_failed_request_is_not_counted_as_sent()
        {
            var diag = new RunDiagnostics();
            var sender = new RecordingSender { FailWith = (request, index) => new InvalidOperationException("boom") };
            var d = new ChangeSetDispatcher(new FakeSupport(), sender, new NullTrace(), diagnostics: diag);

            Assert.Throws<InvalidPluginExecutionException>(() =>
                d.SendBatches(ChangeSet.Build(new[] { Upd("contact", Guid.NewGuid()) }), User, SystemService));

            Assert.Equal(0, diag.WritesSent);
            Assert.Equal(0, diag.SingleRequests);
        }
    }
}
