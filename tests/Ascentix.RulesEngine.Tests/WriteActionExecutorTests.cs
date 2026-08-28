using System;
using System.Collections.Generic;
using System.Linq;
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
                new List<WriteTarget> { new WriteTarget { RecordId = recId, InPlace = null } },
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
                new List<WriteTarget> { new WriteTarget { RecordId = recId, InPlace = null } },
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
                new List<WriteTarget> { new WriteTarget { RecordId = recId, InPlace = target } },
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
                new List<WriteTarget> { new WriteTarget { RecordId = recId, InPlace = new Entity("account", recId) } },
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
                new List<WriteTarget> { new WriteTarget { RecordId = recId, InPlace = null } },
                svc, svc, engineInitiated: false, new NullTrace()));
        }
    }
}
