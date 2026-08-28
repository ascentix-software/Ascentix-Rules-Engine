using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Plugin.Registration;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class StepReconcilerTests
    {
        // In-memory environment: "account" supports the Multiple messages; existing
        // engine steps are whatever we seed.
        private sealed class FakeEnv : IRegistrationEnvironment
        {
            public HashSet<string> SupportedMultiple = new HashSet<string>();
            public List<RegisteredStep> Existing = new List<RegisteredStep>();
            public List<StepRegistration> Created = new List<StepRegistration>();
            public List<(Guid Id, string Filtering)> Updated = new List<(Guid, string)>();
            public List<Guid> Deleted = new List<Guid>();

            public bool SupportsMessage(string messageName, string table) =>
                SupportedMultiple.Contains(messageName);
            public List<RegisteredStep> GetEngineSteps(string table) => Existing;
            public void CreateStep(StepRegistration reg) => Created.Add(reg);
            public void UpdateFilteringAttributes(Guid stepId, string filtering) => Updated.Add((stepId, filtering));
            public void DeleteStep(Guid stepId) => Deleted.Add(stepId);
        }

        [Fact]
        public void Creates_update_step_on_the_multiple_message_when_supported()
        {
            var env = new FakeEnv { SupportedMultiple = { "UpdateMultiple" } };
            var desired = new DesiredSteps { Update = true, UpdateFilteringAttributes = new HashSet<string> { "name" } };

            StepReconciler.Reconcile(env, "account", desired);

            var step = Assert.Single(env.Created);
            Assert.Equal("UpdateMultiple", step.MessageName);
            Assert.Equal("name", step.FilteringAttributes);
            Assert.Empty(env.Deleted);
        }

        [Fact]
        public void Falls_back_to_single_message_when_multiple_unsupported()
        {
            var env = new FakeEnv(); // nothing supported
            var desired = new DesiredSteps { Create = true };

            StepReconciler.Reconcile(env, "account", desired);

            Assert.Equal("Create", Assert.Single(env.Created).MessageName);
        }

        [Fact]
        public void Updates_filtering_attributes_when_they_drift()
        {
            var env = new FakeEnv
            {
                Existing = { new RegisteredStep { Id = Guid.NewGuid(), MessageName = "Update", FilteringAttributes = "name" } }
            };
            var desired = new DesiredSteps { Update = true, UpdateFilteringAttributes = new HashSet<string> { "name", "statuscode" } };

            StepReconciler.Reconcile(env, "account", desired);

            var u = Assert.Single(env.Updated);
            Assert.Equal("name,statuscode", u.Filtering);
            Assert.Empty(env.Created);
            Assert.Empty(env.Deleted);
        }

        [Fact]
        public void Deletes_engine_steps_that_are_no_longer_desired()
        {
            var id = Guid.NewGuid();
            var env = new FakeEnv
            {
                Existing = { new RegisteredStep { Id = id, MessageName = "Delete", FilteringAttributes = null } }
            };
            var desired = new DesiredSteps(); // nothing desired

            StepReconciler.Reconcile(env, "account", desired);

            Assert.Equal(id, Assert.Single(env.Deleted));
            Assert.Empty(env.Created);
        }

        [Fact]
        public void No_op_when_existing_matches_desired()
        {
            var env = new FakeEnv
            {
                Existing = { new RegisteredStep { Id = Guid.NewGuid(), MessageName = "Update", FilteringAttributes = "name,statuscode" } }
            };
            var desired = new DesiredSteps { Update = true, UpdateFilteringAttributes = new HashSet<string> { "statuscode", "name" } };

            StepReconciler.Reconcile(env, "account", desired);

            Assert.Empty(env.Created); Assert.Empty(env.Updated); Assert.Empty(env.Deleted);
        }

        [Fact]
        public void Creates_update_step_with_null_filtering_when_a_traversal_rule_forces_fire_on_all()
        {
            var env = new FakeEnv(); // single Update message
            var desired = new DesiredSteps { Update = true, UpdateFilteringAttributes = null }; // fire on all

            StepReconciler.Reconcile(env, "account", desired);

            var step = Assert.Single(env.Created);
            Assert.Equal("Update", step.MessageName);
            Assert.Null(step.FilteringAttributes); // null => fire on all columns
        }

        [Fact]
        public void Clears_filtering_attributes_when_desired_switches_to_fire_on_all()
        {
            var id = Guid.NewGuid();
            var env = new FakeEnv
            {
                Existing = { new RegisteredStep { Id = id, MessageName = "Update", FilteringAttributes = "name" } }
            };
            var desired = new DesiredSteps { Update = true, UpdateFilteringAttributes = null }; // now fire on all

            StepReconciler.Reconcile(env, "account", desired);

            var u = Assert.Single(env.Updated);
            Assert.Equal(id, u.Id);
            Assert.Null(u.Filtering); // cleared to fire on all
            Assert.Empty(env.Created);
            Assert.Empty(env.Deleted);
        }
    }
}
