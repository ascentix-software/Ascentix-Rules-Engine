using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class WriteActionExecutorTests
    {
        // Records writes issued via Execute (so the 'tag' loop marker can be inspected)
        // and captures the tag that accompanied each request.
        private sealed class RecordingService : IOrganizationService
        {
            public readonly List<Entity> Created = new List<Entity>();
            public readonly List<Entity> Updated = new List<Entity>();
            public readonly List<Tuple<string, Guid>> Deleted = new List<Tuple<string, Guid>>();
            public readonly List<string> Tags = new List<string>();
            public bool FailNextCreate;

            public OrganizationResponse Execute(OrganizationRequest request)
            {
                request.Parameters.TryGetValue("tag", out var tag);
                Tags.Add(tag as string);

                if (request is CreateRequest cr)
                {
                    if (FailNextCreate) throw new InvalidOperationException("boom");
                    var id = cr.Target.Id == Guid.Empty ? Guid.NewGuid() : cr.Target.Id;
                    Created.Add(cr.Target);
                    return new CreateResponse { Results = new ParameterCollection { { "id", id } } };
                }
                if (request is UpdateRequest ur)
                {
                    Updated.Add(ur.Target);
                    return new UpdateResponse();
                }
                if (request is DeleteRequest dr)
                {
                    Deleted.Add(Tuple.Create(dr.Target.LogicalName, dr.Target.Id));
                    return new DeleteResponse();
                }
                throw new NotImplementedException();
            }

            public Guid Create(Entity e) => throw new NotImplementedException();
            public void Update(Entity e) => throw new NotImplementedException();
            public void Delete(string n, Guid id) => throw new NotImplementedException();
            public Entity Retrieve(string n, Guid id, ColumnSet c) => throw new NotImplementedException();
            public void Associate(string n, Guid id, Relationship r, EntityReferenceCollection c) { }
            public void Disassociate(string n, Guid id, Relationship r, EntityReferenceCollection c) { }
            public EntityCollection RetrieveMultiple(QueryBase q) => throw new NotImplementedException();
        }

        private sealed class NullTrace : ITracingService { public void Trace(string f, params object[] a) { } }

        private static RuleEvaluationOutcome Outcome(Guid recId, params WriteIntent[] intents)
        {
            var fired = new List<FiredActionResult>();
            foreach (var i in intents)
                fired.Add(new FiredActionResult { ActionType = ToType(i.Operation), WriteIntent = i });
            return new RuleEvaluationOutcome
            {
                Records = new List<RecordEvaluationResult>
                { new RecordEvaluationResult { RecordId = recId, FiredActions = fired } }
            };
        }
        private static ActionType ToType(WriteOperation op) =>
            op == WriteOperation.Create ? ActionType.CreateRecord :
            op == WriteOperation.Update ? ActionType.UpdateRecord : ActionType.DeleteRecord;

        [Fact]
        public void Applies_service_create_and_tags_it_when_not_engine_initiated()
        {
            var svcUser = new RecordingService();
            var svcSystem = new RecordingService();
            var recId = Guid.NewGuid();
            var intent = new WriteIntent { Operation = WriteOperation.Create, TargetTable = "task",
                Context = RuleEvaluationContext.User,
                Values = new Dictionary<string, object> { ["subject"] = "Hi" } };

            new WriteActionExecutor().Execute(Outcome(recId, intent),
                new List<Entity> { null },
                svcUser, svcSystem, engineInitiated: false, new NullTrace());

            Assert.Single(svcUser.Created);
            Assert.Equal("task", svcUser.Created[0].LogicalName);
            Assert.Equal("Hi", svcUser.Created[0]["subject"]);
            Assert.Equal(PluginReentry.EngineWriteTag, svcUser.Tags.Single());
            Assert.Empty(svcSystem.Created);
        }

        [Fact]
        public void Skips_service_create_when_engine_initiated()
        {
            var svc = new RecordingService();
            var recId = Guid.NewGuid();
            var intent = new WriteIntent { Operation = WriteOperation.Create, TargetTable = "task",
                Context = RuleEvaluationContext.User, Values = new Dictionary<string, object>() };

            new WriteActionExecutor().Execute(Outcome(recId, intent),
                new List<Entity> { null },
                svc, svc, engineInitiated: true, new NullTrace());

            Assert.Empty(svc.Created);
        }

        [Fact]
        public void Root_in_place_update_applies_even_when_engine_initiated()
        {
            var svc = new RecordingService();
            var recId = Guid.NewGuid();
            var target = new Entity("account", recId);
            var intent = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "account",
                TargetId = recId, RootTargeted = true, Context = RuleEvaluationContext.User,
                Values = new Dictionary<string, object> { ["name"] = "X" } };

            // Root-in-place writes onto the in-flight Target: they issue no new operation
            // and cannot cascade, so they apply regardless of engine-initiated re-entry.
            new WriteActionExecutor().Execute(Outcome(recId, intent),
                new List<Entity> { target },
                svc, svc, engineInitiated: true, new NullTrace());

            Assert.Equal("X", target["name"]); // written onto Target
            Assert.Empty(svc.Updated);          // no service Update
        }

        [Fact]
        public void Related_update_and_delete_use_service_and_are_tagged()
        {
            var sys = new RecordingService();
            var recId = Guid.NewGuid();
            var upd = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "contact",
                TargetId = Guid.NewGuid(), RootTargeted = false, Context = RuleEvaluationContext.System,
                Values = new Dictionary<string, object> { ["jobtitle"] = "Mgr" } };
            var del = new WriteIntent { Operation = WriteOperation.Delete, TargetTable = "contact",
                TargetId = Guid.NewGuid(), Context = RuleEvaluationContext.System };

            new WriteActionExecutor().Execute(Outcome(recId, upd, del),
                new List<Entity> { new Entity("account", recId) },
                sys, sys, engineInitiated: false, new NullTrace());

            Assert.Single(sys.Updated);
            Assert.Single(sys.Deleted);
            Assert.All(sys.Tags, t => Assert.Equal(PluginReentry.EngineWriteTag, t));
        }

        [Fact]
        public void Write_failure_propagates()
        {
            var svc = new RecordingService { FailNextCreate = true };
            var recId = Guid.NewGuid();
            var intent = new WriteIntent { Operation = WriteOperation.Create, TargetTable = "task",
                Context = RuleEvaluationContext.User, Values = new Dictionary<string, object>() };

            Assert.ThrowsAny<Exception>(() => new WriteActionExecutor().Execute(Outcome(recId, intent),
                new List<Entity> { null },
                svc, svc, engineInitiated: false, new NullTrace()));
        }

        [Fact]
        public void A_root_update_without_an_in_flight_target_becomes_a_tagged_update()
        {
            var svc = new RecordingService();
            var recId = Guid.NewGuid();
            var intent = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "account",
                TargetId = null, RootTargeted = true, Context = RuleEvaluationContext.User,
                Values = new Dictionary<string, object> { ["description"] = "x" } };
            var record = new RecordEvaluationResult
            {
                RecordId = recId,
                FiredActions = new List<FiredActionResult>
                { new FiredActionResult { ActionType = ActionType.UpdateRecord, WriteIntent = intent } }
            };

            // No in-flight Target (inPlace == null): the root-targeted intent falls back to the
            // record it was evaluated for and is issued as a tagged Update, not written in place.
            var applied = new WriteActionExecutor().ExecuteRecord(record, null, svc, svc,
                engineInitiated: false, new NullTrace());

            Assert.Equal(1, applied);
            Assert.Single(svc.Updated);
            Assert.Equal("account", svc.Updated[0].LogicalName);
            Assert.Equal(recId, svc.Updated[0].Id);
            Assert.Equal("x", svc.Updated[0]["description"]);
            Assert.Equal(PluginReentry.EngineWriteTag, svc.Tags.Single());
        }

        private sealed class NoBulk : IBulkWriteSupport { public bool Supports(string m, string t) => false; }

        private static WriteIntent SetUpdate(Guid id, bool loaded) => new WriteIntent
        {
            Operation = WriteOperation.Update, TargetTable = "contact", TargetId = id, Context = RuleEvaluationContext.User,
            SourceActionName = "Stop bulk email", Values = new Dictionary<string, object> { ["donotbulkemail"] = true },
            LoadedValues = new Dictionary<string, object> { ["donotbulkemail"] = loaded },
        };

        [Fact]
        public void A_set_update_skips_rows_that_already_hold_the_value()
        {
            var svc = new RecordingService();
            var record = new RecordEvaluationResult
            {
                RecordId = Guid.NewGuid(),
                FiredActions = new List<FiredActionResult> { new FiredActionResult { ActionType = ActionType.UpdateRecord,
                    WriteIntents = new List<WriteIntent> { SetUpdate(Guid.NewGuid(), true), SetUpdate(Guid.NewGuid(), false), SetUpdate(Guid.NewGuid(), false) } } },
            };

            var applied = new WriteActionExecutor(_ => new NoBulk(), null).ExecuteRecord(record, null, svc, svc, false, new NullTrace());

            Assert.Equal(2, applied);
            Assert.Equal(2, svc.Updated.Count);
        }

        [Fact]
        public void Two_actions_updating_one_record_send_one_merged_update()
        {
            var svc = new RecordingService();
            var id = Guid.NewGuid();
            var a = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "contact", TargetId = id, SourceActionOrder = 1, AlwaysWrite = true,
                Values = new Dictionary<string, object> { ["description"] = "one" } };
            var b = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "contact", TargetId = id, SourceActionOrder = 2, AlwaysWrite = true,
                Values = new Dictionary<string, object> { ["donotbulkemail"] = true } };

            new WriteActionExecutor(_ => new NoBulk(), null).Execute(Outcome(Guid.NewGuid(), a, b), new List<Entity>(), svc, svc, false, new NullTrace());

            var update = Assert.Single(svc.Updated);
            Assert.Equal("one", update["description"]);
            Assert.Equal(true, update["donotbulkemail"]);
        }

        [Fact]
        public void An_engine_initiated_save_skips_set_writes_but_still_writes_in_place()
        {
            var svc = new RecordingService();
            var recId = Guid.NewGuid();
            var target = new Entity("account", recId);
            var root = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "account", TargetId = recId, RootTargeted = true, AlwaysWrite = true,
                Values = new Dictionary<string, object> { ["name"] = "X" } };
            var record = new RecordEvaluationResult
            {
                RecordId = recId,
                FiredActions = new List<FiredActionResult>
                {
                    new FiredActionResult { ActionType = ActionType.UpdateRecord, WriteIntent = root },
                    new FiredActionResult { ActionType = ActionType.UpdateRecord, WriteIntents = new List<WriteIntent> { SetUpdate(Guid.NewGuid(), false) } },
                },
            };

            var applied = new WriteActionExecutor(_ => new NoBulk(), null).ExecuteRecord(record, target, svc, svc, engineInitiated: true, new NullTrace());

            Assert.Equal(1, applied);
            Assert.Equal("X", target["name"]);
            Assert.Empty(svc.Updated);
        }

        [Fact]
        public void A_failed_write_names_the_action()
        {
            var svc = new RecordingService { FailNextCreate = true };
            var create = new WriteIntent { Operation = WriteOperation.Create, TargetTable = "task", TargetId = Guid.NewGuid(), SourceActionName = "Make follow-up",
                Values = new Dictionary<string, object> { ["subject"] = "x" } };
            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                new WriteActionExecutor(_ => new NoBulk(), null).Execute(Outcome(Guid.NewGuid(), create), new List<Entity>(), svc, svc, false, new NullTrace()));
            Assert.Equal("Create task (action \"Make follow-up\"): boom", ex.Message);
        }

        [Fact]
        public void Diagnostics_record_the_change_set_the_in_place_write_and_the_rows_sent()
        {
            var svc = new RecordingService();
            var recId = Guid.NewGuid();
            var rootUpdate = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "account", TargetId = recId,
                RootTargeted = true, Values = new Dictionary<string, object> { ["description"] = "x" } };
            var related = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "contact", TargetId = Guid.NewGuid(),
                Values = new Dictionary<string, object> { ["jobtitle"] = "y" } };
            var diag = new RunDiagnostics();

            new WriteActionExecutor().Execute(Outcome(recId, rootUpdate, related), new List<Entity> { new Entity("account", recId) },
                svc, svc, engineInitiated: false, new NullTrace(), diag);

            Assert.Equal(1, diag.InPlaceWrites);
            Assert.Equal(1, diag.WritesSent);
            Assert.Equal(1, diag.SingleRequests);
            Assert.Equal(0, diag.BulkRequests);
            foreach (var stage in new[] { "changeSetBuild", "applyInPlace", "dispatch:Update:contact" })
                Assert.Contains(diag.Stages, s => s.Name == stage);
        }

        [Fact]
        public void An_engine_initiated_save_counts_its_in_place_write_but_sends_nothing()
        {
            var svc = new RecordingService();
            var recId = Guid.NewGuid();
            var rootUpdate = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "account", TargetId = recId,
                RootTargeted = true, Values = new Dictionary<string, object> { ["description"] = "x" } };
            var related = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "contact", TargetId = Guid.NewGuid(),
                Values = new Dictionary<string, object> { ["jobtitle"] = "y" } };
            var diag = new RunDiagnostics();

            new WriteActionExecutor().Execute(Outcome(recId, rootUpdate, related), new List<Entity> { new Entity("account", recId) },
                svc, svc, engineInitiated: true, new NullTrace(), diag);

            Assert.Equal(1, diag.InPlaceWrites);
            Assert.Equal(0, diag.WritesSent);
            Assert.Equal(0, diag.SingleRequests);
            Assert.DoesNotContain(diag.Stages, s => s.Name.StartsWith("dispatch:"));
        }

        [Fact]
        public void Diagnostics_count_unchanged_and_merged_writes()
        {
            var svc = new RecordingService();
            var merged = Guid.NewGuid();
            var first = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "contact", TargetId = merged, SourceActionOrder = 1,
                Values = new Dictionary<string, object> { ["jobtitle"] = "y" } };
            var second = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "contact", TargetId = merged, SourceActionOrder = 2,
                Values = new Dictionary<string, object> { ["description"] = "z" } };
            var same = new WriteIntent { Operation = WriteOperation.Update, TargetTable = "contact", TargetId = Guid.NewGuid(), SourceActionOrder = 3,
                Values = new Dictionary<string, object> { ["jobtitle"] = "y" },
                LoadedValues = new Dictionary<string, object> { ["jobtitle"] = "y" } };
            var diag = new RunDiagnostics();

            new WriteActionExecutor().ExecuteRecord(Outcome(Guid.NewGuid(), first, second, same).Records[0], null,
                svc, svc, engineInitiated: false, new NullTrace(), diag);

            Assert.Equal(1, diag.WritesMerged);
            Assert.Equal(1, diag.WritesUnchanged);
            Assert.Equal(1, diag.WritesSent);
        }
    }
}
