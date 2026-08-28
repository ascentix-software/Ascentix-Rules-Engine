using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Plugin.Registration;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>The asx_SyncSteps mechanics: bulk drift repair via the existing
    /// reconciler, orphan cleanup, deactivated-step preservation, RemoveAll scoping.</summary>
    public class StepSyncServiceTests
    {
        private sealed class FakeEnv : IStepSyncEnvironment
        {
            public HashSet<string> SupportedMultiple = new HashSet<string>();
            public Dictionary<string, List<RegisteredStep>> StepsByTable =
                new Dictionary<string, List<RegisteredStep>>(StringComparer.OrdinalIgnoreCase);
            public List<StepRegistration> Created = new List<StepRegistration>();
            public List<(Guid Id, string Filtering)> Updated = new List<(Guid, string)>();
            public List<Guid> Deleted = new List<Guid>();

            public RegisteredStep Seed(string table, string message, string filtering = null, bool isActive = true)
            {
                var step = new RegisteredStep
                {
                    Id = Guid.NewGuid(),
                    MessageName = message,
                    FilteringAttributes = filtering,
                    Name = DataverseRegistrationEnvironment.StepName(table, message),
                    IsActive = isActive
                };
                if (!StepsByTable.TryGetValue(table, out var list))
                    StepsByTable[table] = list = new List<RegisteredStep>();
                list.Add(step);
                return step;
            }

            public bool SupportsMessage(string messageName, string table) =>
                SupportedMultiple.Contains(messageName);
            public List<RegisteredStep> GetEngineSteps(string table) =>
                StepsByTable.TryGetValue(table, out var list) ? list : new List<RegisteredStep>();
            public List<RegisteredStep> GetAllEngineSteps() =>
                StepsByTable.Values.SelectMany(s => s).ToList();
            public void CreateStep(StepRegistration reg) => Created.Add(reg);
            public void UpdateFilteringAttributes(Guid stepId, string filtering) => Updated.Add((stepId, filtering));
            public void DeleteStep(Guid stepId) => Deleted.Add(stepId);
        }

        private static DesiredSteps CreateOnly() => new DesiredSteps { Create = true };

        [Fact]
        public void Drifted_table_missing_step_is_recreated_and_counted()
        {
            var env = new FakeEnv(); // rules want a Create step; no step exists
            var outcome = StepSyncService.Sync(new[] { "account" }, env, _ => CreateOnly());

            Assert.Equal(1, outcome.TablesProcessed);
            Assert.Equal(1, outcome.StepsCreated);
            Assert.Equal("Create", Assert.Single(env.Created).MessageName);
            Assert.Contains("Ascentix.RulesEngine: account Create",
                Assert.Single(outcome.Tables, t => !t.IsEmpty).Created);
        }

        [Fact]
        public void Orphaned_table_steps_without_rules_is_swept_via_step_name_parse()
        {
            var env = new FakeEnv();
            var orphan = env.Seed("contact", "Update");

            // No rule tables at all, so contact is discovered from the step name alone.
            var outcome = StepSyncService.Sync(new string[0], env, _ => new DesiredSteps());

            Assert.Equal(1, outcome.TablesProcessed);
            Assert.Equal(1, outcome.StepsDeleted);
            Assert.Equal(orphan.Id, Assert.Single(env.Deleted));
            Assert.Contains(orphan.Name, outcome.Tables.Single(t => t.Table == "contact").Deleted);
        }

        [Fact]
        public void Wrong_filtering_attributes_are_repaired_and_counted_by_name()
        {
            var env = new FakeEnv();
            var step = env.Seed("account", "Update", filtering: "name");
            var desired = new DesiredSteps
            {
                Update = true,
                UpdateFilteringAttributes = new HashSet<string> { "name", "statuscode" }
            };

            var outcome = StepSyncService.Sync(new[] { "account" }, env, _ => desired);

            Assert.Equal(1, outcome.StepsUpdated);
            Assert.Equal("name,statuscode", Assert.Single(env.Updated).Filtering);
            Assert.Contains(step.Name, outcome.Tables.Single(t => t.Table == "account").Updated);
        }

        [Fact]
        public void Deactivated_step_is_preserved_and_reported_never_reenabled()
        {
            var env = new FakeEnv();
            var dormant = env.Seed("account", "Create", isActive: false);

            // Rules still want the Create step; the deactivated one satisfies "exists".
            var outcome = StepSyncService.Sync(new[] { "account" }, env, _ => CreateOnly());

            Assert.Empty(env.Created);
            Assert.Empty(env.Deleted);
            Assert.Equal(1, outcome.DeactivatedStepsFound);
            Assert.Contains(dormant.Name, outcome.Tables.Single(t => t.Table == "account").Deactivated);
        }

        [Fact]
        public void RemoveAll_deletes_everything_engine_owned_including_deactivated()
        {
            var env = new FakeEnv();
            env.Seed("account", "Create");
            env.Seed("account", "Update", isActive: false);
            env.Seed("contact", "Delete");

            var outcome = StepSyncService.RemoveAll(env);

            Assert.Equal(2, outcome.TablesProcessed);
            Assert.Equal(3, outcome.StepsDeleted);
            Assert.Equal(3, env.Deleted.Count);
            Assert.Equal(0, outcome.StepsCreated);
        }

        [Fact]
        public void Sync_unions_rule_tables_with_step_tables()
        {
            var env = new FakeEnv();
            env.Seed("contact", "Update"); // step, no rules
            var planned = new List<string>();

            StepSyncService.Sync(new[] { "account" }, env, t => { planned.Add(t); return new DesiredSteps(); });

            Assert.Equal(new[] { "account", "contact" }, planned.OrderBy(t => t).ToArray());
        }

        [Theory]
        [InlineData("Ascentix.RulesEngine: account Update", "account")]
        [InlineData("Ascentix.RulesEngine: asx_some_table CreateMultiple", "asx_some_table")]
        [InlineData("Ascentix.RulesEngine: nomessage", null)] // no table/message split
        [InlineData("Someone Else: account Update", null)]    // not the engine prefix
        [InlineData(null, null)]
        public void TableFromStepName_parses_the_convention_only(string name, string expected)
        {
            Assert.Equal(expected, StepSyncService.TableFromStepName(name));
        }

        [Fact]
        public void DetailsJson_lists_only_tables_where_something_happened()
        {
            var env = new FakeEnv();
            env.Seed("account", "Create"); // in sync: nothing to do
            var outcome = StepSyncService.Sync(
                new[] { "account", "contact" }, env,
                t => t == "contact" ? CreateOnly() : new DesiredSteps { Create = true });

            var json = outcome.DetailsJson();
            Assert.Contains("\"table\":\"contact\"", json);
            Assert.Contains("Ascentix.RulesEngine: contact Create", json);
            Assert.DoesNotContain("\"table\":\"account\"", json); // no-op table omitted
        }
    }
}
