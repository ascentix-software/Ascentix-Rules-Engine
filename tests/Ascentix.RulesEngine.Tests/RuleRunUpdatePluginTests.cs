using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Pre-operation Update of asx_rulerun: outside asx_ProcessRunPage, the only change allowed is
    /// cancelling a queued or running run, so a caller can't rewrite a run's scope, record ids or
    /// state to get around its rule's Runs for setting.
    /// </summary>
    public class RuleRunUpdatePluginTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private readonly TransactionalPluginContext _ctx = new TransactionalPluginContext();
        private readonly Guid _runId = Guid.NewGuid();

        private void SeedRun(RuleRunStatus status)
        {
            _ctx.Initialize(new List<Entity>
            {
                new Entity(Q(SchemaNames.RuleRun.Entity), _runId)
                {
                    [Q(SchemaNames.RuleRun.Status)] = new OptionSetValue((int)status),
                    [Q(SchemaNames.RuleRun.Scope)] = new OptionSetValue((int)OnDemandScope.GivenRecord),
                },
            });
        }

        private Entity Target(params KeyValuePair<string, object>[] values)
        {
            var target = new Entity(Q(SchemaNames.RuleRun.Entity), _runId)
            {
                // The platform adds these to every Update's Target; they never count as an edit.
                ["modifiedon"] = DateTime.UtcNow,
                ["modifiedby"] = new EntityReference("systemuser", Guid.NewGuid()),
            };
            foreach (var kv in values) target[kv.Key] = kv.Value;
            return target;
        }

        private static KeyValuePair<string, object> Status(RuleRunStatus status) =>
            new KeyValuePair<string, object>(Q(SchemaNames.RuleRun.Status), new OptionSetValue((int)status));

        private void Update(Entity target, XrmFakedPluginExecutionContext parent = null) =>
            _ctx.ExecuteTransactional<RuleRunUpdatePlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "Update",
                Stage = 20,
                PrimaryEntityName = Q(SchemaNames.RuleRun.Entity),
                InputParameters = new ParameterCollection { { "Target", target } },
                ParentContext = parent,
            });

        [Theory]
        [InlineData(RuleRunStatus.Queued)]
        [InlineData(RuleRunStatus.Running)]
        public void Cancelling_a_queued_or_running_run_is_allowed(RuleRunStatus current)
        {
            SeedRun(current);

            Update(Target(Status(RuleRunStatus.Cancelled)));
        }

        [Fact]
        public void Editing_a_runs_scope_is_refused()
        {
            SeedRun(RuleRunStatus.Running);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => Update(Target(
                new KeyValuePair<string, object>(Q(SchemaNames.RuleRun.Scope), new OptionSetValue((int)OnDemandScope.AllRecords)))));

            Assert.Equal("Only cancelling a run is allowed.", ex.Message);
        }

        [Fact]
        public void Cancelling_while_editing_another_column_is_refused()
        {
            SeedRun(RuleRunStatus.Running);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => Update(Target(
                Status(RuleRunStatus.Cancelled),
                new KeyValuePair<string, object>(Q(SchemaNames.RuleRun.RecordIds), "[]"))));

            Assert.Equal("Only cancelling a run is allowed.", ex.Message);
        }

        [Fact]
        public void Reopening_a_completed_run_is_refused()
        {
            SeedRun(RuleRunStatus.Completed);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => Update(Target(Status(RuleRunStatus.Running))));

            Assert.Equal("Only cancelling a run is allowed.", ex.Message);
        }

        [Fact]
        public void Cancelling_a_finished_run_is_refused()
        {
            SeedRun(RuleRunStatus.Completed);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => Update(Target(Status(RuleRunStatus.Cancelled))));

            Assert.Equal("Only cancelling a run is allowed.", ex.Message);
        }

        [Fact]
        public void The_page_processors_own_saves_are_allowed()
        {
            SeedRun(RuleRunStatus.Running);
            var page = new XrmFakedPluginExecutionContext { MessageName = Q(SchemaNames.ProcessRunPageApi.MessageName), Stage = 30 };

            Update(Target(
                Status(RuleRunStatus.Completed),
                new KeyValuePair<string, object>(Q(SchemaNames.RuleRun.Evaluated), 4),
                new KeyValuePair<string, object>(Q(SchemaNames.RuleRun.Bookmark), "{}")), page);
        }
    }
}
