using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Ascentix.RulesEngine.Core.Diagnostics;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeItEasy;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;
using CoreModels = Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// The opt-in diagnostics table: while the asx_CaptureDiagnostics environment variable is on, a
    /// form save writes one asx_rulediagnostic row per saved record with its full diagnostics JSON.
    /// Off (the default) nothing is written, and nothing about the switch or the row ever reaches
    /// the save's own outcome.
    /// </summary>
    public class DiagnosticsCaptureTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);
        private static readonly string Row = Q(SchemaNames.RuleDiagnostic.Entity);
        private static readonly DateTime Start = new DateTime(2026, 9, 30, 12, 0, 0, DateTimeKind.Utc);

        // ── Seeds ────────────────────────────────────────────────────────────────

        // The switch's definition (and, when given, its value row). A null default leaves the
        // definition without one; a null value leaves no value row.
        private static List<Entity> Switch(string defaultValue, string value)
        {
            var definition = new Entity("environmentvariabledefinition", Guid.NewGuid())
            {
                ["schemaname"] = Q(SchemaNames.EnvironmentVariables.CaptureDiagnostics),
            };
            if (defaultValue != null) definition["defaultvalue"] = defaultValue;
            var seed = new List<Entity> { definition };
            if (value != null)
            {
                seed.Add(new Entity("environmentvariablevalue", Guid.NewGuid())
                {
                    ["environmentvariabledefinitionid"] = definition.ToEntityReference(),
                    ["value"] = value,
                });
            }
            return seed;
        }

        // account.name must equal "Valid", else Block (OnCreate).
        private static List<Entity> BlockRule()
        {
            var ids = (rule: Guid.NewGuid(), cfg: Guid.NewGuid(), grp: Guid.NewGuid());
            return new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), ids.cfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.Rule.Entity), ids.rule)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), Guid.NewGuid())
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                    [Q(SchemaNames.RuleCondition.ComparisonValue)] = "Valid",
                },
                new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid())
                {
                    [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                    [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnNoMatch),
                    [Q(SchemaNames.RuleAction.Message)] = "Name must be Valid.",
                    [Q(SchemaNames.RuleAction.Order)] = 1,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                },
            };
        }

        private static XrmFakedPluginExecutionContext CreateOf(Entity target) => new XrmFakedPluginExecutionContext
        {
            MessageName = "Create",
            Stage = 20,
            CorrelationId = Guid.NewGuid(),
            InputParameters = new ParameterCollection { { "Target", target } },
        };

        // ── Harness ──────────────────────────────────────────────────────────────

        /// <summary>A service that counts switch reads and can refuse diagnostics rows or switch reads.</summary>
        private sealed class WatchedService : IOrganizationService
        {
            private readonly IOrganizationService _inner;
            public int SwitchReads;
            public bool FailRowWrites;
            public bool FailSwitchReads;

            public WatchedService(IOrganizationService inner) { _inner = inner; }

            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                if (query is QueryExpression qe && qe.EntityName == "environmentvariabledefinition")
                {
                    SwitchReads++;
                    if (FailSwitchReads) throw new InvalidOperationException("switch read refused");
                }
                return _inner.RetrieveMultiple(query);
            }

            public Guid Create(Entity entity)
            {
                if (FailRowWrites && entity.LogicalName == Row)
                    throw new InvalidOperationException("row write {refused}");
                return _inner.Create(entity);
            }

            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => _inner.Retrieve(entityName, id, columnSet);
            public void Update(Entity entity) => _inner.Update(entity);
            public void Delete(string entityName, Guid id) => _inner.Delete(entityName, id);
            public OrganizationResponse Execute(OrganizationRequest request) => _inner.Execute(request);
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities)
                => _inner.Associate(entityName, entityId, relationship, relatedEntities);
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities)
                => _inner.Disassociate(entityName, entityId, relationship, relatedEntities);
        }

        private sealed class RecordingTrace : ITracingService
        {
            public readonly List<string> Lines = new List<string>();
            public void Trace(string format, params object[] args) => Lines.Add(args.Length == 0 ? format : string.Format(format, args));
        }

        private sealed class SaveContext : XrmFakedContext
        {
            public IServiceProvider Provider(XrmFakedPluginExecutionContext pctx) => GetFakedServiceProvider(pctx);
        }

        private sealed class Save
        {
            public SaveContext Fake;
            public WatchedService System;
            public WatchedService User;
            public DiagnosticsCapture Capture;
            public DateTime Now = Start;

            public Save(IEnumerable<Entity> seed)
            {
                Fake = new SaveContext();
                Fake.Initialize(seed);
                System = new WatchedService(Fake.GetOrganizationService());
                User = new WatchedService(Fake.GetOrganizationService());
                Capture = new DiagnosticsCapture(() => Now);
            }

            /// <summary>Runs RulesEnginePlugin with this save's capture, the system and user services
            /// wrapped so each can be watched or made to fail.</summary>
            public void Run(XrmFakedPluginExecutionContext pctx)
            {
                var provider = Fake.Provider(pctx);
                var factory = A.Fake<IOrganizationServiceFactory>();
                A.CallTo(() => factory.CreateOrganizationService(A<Guid?>._))
                    .ReturnsLazily((Guid? userId) => userId.HasValue ? (IOrganizationService)User : System);
                A.CallTo(() => provider.GetService(typeof(IOrganizationServiceFactory))).Returns(factory);
                new RulesEnginePlugin(Capture).Execute(provider);
            }

            public List<Entity> Rows() => Fake.GetOrganizationService()
                .RetrieveMultiple(new QueryExpression(Row) { ColumnSet = new ColumnSet(true) }).Entities.ToList();

            public string Trace() => Fake.GetFakeTracingService().DumpTrace();
        }

        private static long TotalMs(string json) =>
            long.Parse(Regex.Match(json, "\"totalMs\":(\\d+)").Groups[1].Value);

        private static string TraceLineJson(string trace)
        {
            var line = trace.Split('\n').Single(l => l.Contains(RunDiagnosticsSerializer.TracePrefix));
            return line.Substring(line.IndexOf(RunDiagnosticsSerializer.TracePrefix, StringComparison.Ordinal)
                + RunDiagnosticsSerializer.TracePrefix.Length).Trim();
        }

        // ── 1. Off ──────────────────────────────────────────────────────────────

        [Theory]
        [InlineData(null, null)]      // definition with neither a default nor a value
        [InlineData("no", null)]      // the shipped default
        [InlineData("false", null)]
        [InlineData("0", null)]
        [InlineData("yes", "no")]     // a value overrides the default
        [InlineData("true", "false")]
        [InlineData("1", "0")]
        public void Switch_off_writes_no_row_and_leaves_the_save_unchanged(string defaultValue, string value)
        {
            var save = new Save(Switch(defaultValue, value));

            Assert.Null(Record.Exception(() => save.Run(CreateOf(new Entity("account", Guid.NewGuid()) { ["name"] = "Acme" }))));

            Assert.Empty(save.Rows());
            Assert.StartsWith("{\"totalMs\":", TraceLineJson(save.Trace()));
        }

        [Fact]
        public void A_missing_definition_counts_as_off()
        {
            var save = new Save(new List<Entity>());

            Assert.Null(Record.Exception(() => save.Run(CreateOf(new Entity("account", Guid.NewGuid()) { ["name"] = "Acme" }))));

            Assert.Empty(save.Rows());
            Assert.Equal(1, save.System.SwitchReads);
            Assert.DoesNotContain("could not be read", save.Trace());   // off, not a failed read
        }

        // ── 2. On ───────────────────────────────────────────────────────────────

        [Theory]
        [InlineData("true", null)]
        [InlineData("yes", null)]
        [InlineData("1", null)]
        [InlineData("no", "TRUE")]   // a value overrides the default, case-insensitively
        [InlineData("false", "Yes")]
        [InlineData("0", "1")]
        public void Switch_on_writes_one_row_for_the_saved_record(string defaultValue, string value)
        {
            var save = new Save(Switch(defaultValue, value));
            var target = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme" };
            var pctx = CreateOf(target);

            save.Run(pctx);

            var row = Assert.Single(save.Rows());
            Assert.Equal("account Create", row[Q(SchemaNames.RuleDiagnostic.Name)]);
            Assert.Equal("account", row[Q(SchemaNames.RuleDiagnostic.TableLogicalName)]);
            Assert.Equal(target.Id.ToString("D"), row[Q(SchemaNames.RuleDiagnostic.RecordId)]);
            Assert.Equal("Create", row[Q(SchemaNames.RuleDiagnostic.MessageName)]);
            Assert.Equal(pctx.CorrelationId.ToString("D"), row[Q(SchemaNames.RuleDiagnostic.CorrelationId)]);
            var json = (string)row[Q(SchemaNames.RuleDiagnostic.Diagnostics)];
            Assert.StartsWith("{\"totalMs\":", json);
            // The row carries the whole save's totalMs: the same figure as the save's asx-diag line.
            Assert.Equal(TotalMs(TraceLineJson(save.Trace())), TotalMs(json));
        }

        [Fact]
        public void A_multi_record_save_writes_one_row_per_record_with_the_full_uncapped_json()
        {
            var save = new Save(Switch("yes", null));
            var d = new RunDiagnostics { TotalMs = 42, WritesSent = 3 };
            for (var i = 0; i < 200; i++) d.RecordRetrieveMultiple(Guid.NewGuid(), "perf_child1", i);
            var ids = new[] { Guid.NewGuid(), Guid.NewGuid() };
            var pctx = new XrmFakedPluginExecutionContext { MessageName = "UpdateMultiple", CorrelationId = Guid.NewGuid() };

            save.Capture.Write(save.System, pctx, "perf_root", ids, d, new RecordingTrace());

            var rows = save.Rows();
            Assert.Equal(ids.Select(id => id.ToString("D")).OrderBy(s => s),
                rows.Select(r => (string)r[Q(SchemaNames.RuleDiagnostic.RecordId)]).OrderBy(s => s));
            var full = RunDiagnosticsSerializer.Serialize(d);
            Assert.True(full.Length > RunDiagnosticsSerializer.MaxTraceLineBytes, "the fixture must exceed the trace line cap");
            Assert.All(rows, r =>
            {
                Assert.Equal(full, r[Q(SchemaNames.RuleDiagnostic.Diagnostics)]);
                Assert.Equal("perf_root UpdateMultiple", r[Q(SchemaNames.RuleDiagnostic.Name)]);
            });
        }

        // ── 3. The switch is cached for 60 seconds ─────────────────────────────

        [Fact]
        public void The_switch_is_read_at_most_once_a_minute()
        {
            var seed = Switch("no", null);
            var save = new Save(seed);
            var d = new RunDiagnostics { TotalMs = 1 };
            var trace = new RecordingTrace();
            void Write() => save.Capture.Write(save.System,
                new XrmFakedPluginExecutionContext { MessageName = "Update", CorrelationId = Guid.NewGuid() },
                "account", new[] { Guid.NewGuid() }, d, trace);

            Write();
            Assert.Equal(1, save.System.SwitchReads);

            // Turned on 30 s later: the cached "off" still holds, with no second query.
            save.Fake.GetOrganizationService().Create(new Entity("environmentvariablevalue")
            {
                ["environmentvariabledefinitionid"] = seed[0].ToEntityReference(),
                ["value"] = "yes",
            });
            save.Now = Start.AddSeconds(59);
            Write();
            Assert.Equal(1, save.System.SwitchReads);
            Assert.Empty(save.Rows());

            // At 60 s the switch is read again and the change takes effect.
            save.Now = Start.AddSeconds(60);
            Write();
            Assert.Equal(2, save.System.SwitchReads);
            Assert.Single(save.Rows());
        }

        [Fact]
        public void A_failed_switch_read_counts_as_off_until_the_next_refresh()
        {
            var save = new Save(Switch("yes", null));
            save.System.FailSwitchReads = true;
            var trace = new RecordingTrace();
            var pctx = new XrmFakedPluginExecutionContext { MessageName = "Update", CorrelationId = Guid.NewGuid() };

            Assert.Null(Record.Exception(() =>
                save.Capture.Write(save.System, pctx, "account", new[] { Guid.NewGuid() }, new RunDiagnostics(), trace)));
            save.Now = Start.AddSeconds(30);
            save.Capture.Write(save.System, pctx, "account", new[] { Guid.NewGuid() }, new RunDiagnostics(), trace);

            Assert.Empty(save.Rows());
            Assert.Equal(1, save.System.SwitchReads);
            Assert.Contains(trace.Lines, l => l.Contains("switch read refused"));
        }

        // ── 4. A failing row write never reaches the save ──────────────────────

        [Fact]
        public void A_failing_row_write_is_swallowed_and_traced()
        {
            var save = new Save(Switch("yes", null));
            save.System.FailRowWrites = true;
            var trace = new RecordingTrace();
            var pctx = new XrmFakedPluginExecutionContext { MessageName = "Update", CorrelationId = Guid.NewGuid() };

            Assert.Null(Record.Exception(() =>
                save.Capture.Write(save.System, pctx, "account", new[] { Guid.NewGuid() }, new RunDiagnostics(), trace)));

            Assert.Contains(trace.Lines, l => l.Contains("row write {refused}"));
        }

        [Fact]
        public void A_failing_row_write_leaves_a_successful_save_successful()
        {
            var save = new Save(Switch("yes", null));
            save.System.FailRowWrites = true;

            Assert.Null(Record.Exception(() => save.Run(CreateOf(new Entity("account", Guid.NewGuid()) { ["name"] = "Acme" }))));

            Assert.Empty(save.Rows());
            Assert.Contains("row write {refused}", save.Trace());
        }

        // ── 5. Blocked saves ────────────────────────────────────────────────────

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void A_blocked_save_attempts_its_row_and_keeps_its_block_error(bool rowWriteFails)
        {
            var save = new Save(BlockRule().Concat(Switch("yes", null)));
            save.System.FailRowWrites = rowWriteFails;

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                save.Run(CreateOf(new Entity("account", Guid.NewGuid()) { ["name"] = "Invalid" })));

            Assert.Contains("Name must be Valid.", ex.Message);
            Assert.DoesNotContain("refused", ex.Message);
            if (rowWriteFails) Assert.Empty(save.Rows());
            else Assert.Single(save.Rows());
        }

        // ── 6. The system service reads the switch and writes the row ──────────

        [Fact]
        public void The_switch_and_the_row_go_through_the_system_service()
        {
            var save = new Save(Switch("no", "yes"));
            // The saving user can neither read the switch nor write a diagnostics row.
            save.User.FailSwitchReads = true;
            save.User.FailRowWrites = true;

            save.Run(CreateOf(new Entity("account", Guid.NewGuid()) { ["name"] = "Acme" }));

            Assert.Single(save.Rows());
            Assert.Equal(1, save.System.SwitchReads);
            Assert.Equal(0, save.User.SwitchReads);
        }
    }
}
