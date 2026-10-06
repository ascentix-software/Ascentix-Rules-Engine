using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RulesEngineRunnerTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // account.name must equal "Valid"; Block when that outcome is false: "Name must be Valid.".
        // ctx lets the caller set the rule's asx_evaluationcontext (null = leave unset → User).
        private static List<Entity> Seed(RuleEvaluationContext? ctx = null)
        {
            var ids = (rule: Guid.NewGuid(), cfg: Guid.NewGuid(), grp: Guid.NewGuid(),
                       cond: Guid.NewGuid(), act: Guid.NewGuid());

            var tableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.cfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ids.rule)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnDemand) }),
            };
            if (ctx.HasValue)
                rule[Q(SchemaNames.Rule.EvaluationContext)] = new OptionSetValue((int)ctx.Value);

            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
            };
            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), ids.cond)
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                [Q(SchemaNames.RuleCondition.ComparisonValue)] = "Valid",
            };
            var action = new Entity(Q(SchemaNames.RuleAction.Entity), ids.act)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.Block),
                [Q(SchemaNames.RuleAction.Message)] = "Name must be Valid.",
                [Q(SchemaNames.RuleAction.Order)] = 1,
                [Q(SchemaNames.RuleAction.IsActive)] = true,
            };
            var rows = new List<Entity> { tableConfig, rule, group, condition, action };
            rows.AddRange(ActionTreeRows.AnyFalse(ids.act, ids.grp));
            return rows;
        }

        private static RuleEvaluationOutcome Run(XrmFakedContext ctx, Entity overlay)
        {
            var service = ctx.GetOrganizationService();
            return new RulesEngineRunner().Run(
                systemService: service,
                userService: service,
                logicalName: "account",
                inputs: new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                trigger: RuleTrigger.OnDemand,
                channel: RuleChannel.Standard,
                languageId: 1033,
                buildMode: RootBuildMode.UseTarget,
                trace: new XrmFakedTracingService());
        }

        [Fact]
        public void System_context_rule_is_evaluated_and_blocks()
        {
            // A rule explicitly marked System still evaluates (here systemService == userService).
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed(RuleEvaluationContext.System));
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Invalid" };

            var outcome = Run(ctx, overlay);

            Assert.False(outcome.IsValid);
            Assert.Equal("Name must be Valid.", outcome.Records.Single().FiredActions.Single().Message);
        }

        [Fact]
        public void Returns_one_empty_record_when_no_rules()
        {
            var ctx = new XrmFakedContext(); // no rules seeded
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "whatever" };

            var outcome = Run(ctx, overlay);

            Assert.True(outcome.IsValid);
            Assert.Equal(0, outcome.FailedRuleCount);
            Assert.Empty(outcome.Records.Single().FiredActions);
            Assert.Equal(overlay.Id, outcome.Records.Single().RecordId);
        }

        // Adds "lastusedincampaign >= now - 1 day" to a seeded rule's condition group.
        private static void AddDateCondition(List<Entity> seed)
        {
            var groupId = seed.Single(e => e.LogicalName == Q(SchemaNames.ConditionGroup.Entity)).Id;
            var cfgId = seed.Single(e => e.LogicalName == Q(SchemaNames.TableConfig.Entity)).Id;
            seed.Add(new Entity(Q(SchemaNames.RuleCondition.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), groupId),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), cfgId),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "lastusedincampaign",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.GreaterThanOrEqual),
                [Q(SchemaNames.RuleCondition.ComparisonValueSource)] = new OptionSetValue((int)ComparisonValueSource.DateExpression),
                [Q(SchemaNames.RuleCondition.ComparisonValue)] = "{\"anchor\":{\"kind\":\"now\"},\"op\":\"subtract\",\"amount\":1,\"unit\":\"days\"}",
            });
        }

        // The rule's date semantics read the column's behavior from metadata on the first date
        // comparison (see DateSemantics/AttributeMetadataProvider); "account" must be registered
        // so lastusedincampaign resolves to its (default) Instant kind.
        private static void InitializeAccountMetadata(XrmFakedContext ctx)
        {
            var accountMetadata = new EntityMetadata { LogicalName = "account" };
            typeof(EntityMetadata).GetProperty("Attributes").SetValue(accountMetadata, new AttributeMetadata[]
            {
                new StringAttributeMetadata { LogicalName = "name" },
                new DateTimeAttributeMetadata { LogicalName = "lastusedincampaign" },
            });
            ctx.InitializeMetadata(new List<EntityMetadata> { accountMetadata });
        }

        /// <summary>Counts RetrieveEntity requests per table on the way to the faked service.</summary>
        private sealed class MetadataCountingService : IOrganizationService
        {
            private readonly IOrganizationService _inner;
            public readonly Dictionary<string, int> Retrieves = new Dictionary<string, int>();
            public MetadataCountingService(IOrganizationService inner) { _inner = inner; }

            public OrganizationResponse Execute(OrganizationRequest request)
            {
                if (request is Microsoft.Xrm.Sdk.Messages.RetrieveEntityRequest r)
                    Retrieves[r.LogicalName] = (Retrieves.TryGetValue(r.LogicalName, out var n) ? n : 0) + 1;
                return _inner.Execute(request);
            }
            public Guid Create(Entity entity) => _inner.Create(entity);
            public Entity Retrieve(string entityName, Guid id, Microsoft.Xrm.Sdk.Query.ColumnSet columnSet) => _inner.Retrieve(entityName, id, columnSet);
            public void Update(Entity entity) => _inner.Update(entity);
            public void Delete(string entityName, Guid id) => _inner.Delete(entityName, id);
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => _inner.Associate(entityName, entityId, relationship, relatedEntities);
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => _inner.Disassociate(entityName, entityId, relationship, relatedEntities);
            public EntityCollection RetrieveMultiple(Microsoft.Xrm.Sdk.Query.QueryBase query) => _inner.RetrieveMultiple(query);
        }

        [Fact]
        public void Buckets_of_one_run_share_one_metadata_read_per_table()
        {
            // Two rules in different evaluation contexts are two buckets; both compare a date
            // on account. Metadata is per table, not per rule: one RetrieveEntity for the run.
            var user = Seed(RuleEvaluationContext.User);
            var system = Seed(RuleEvaluationContext.System);
            AddDateCondition(user);
            AddDateCondition(system);
            var ctx = new XrmFakedContext();
            InitializeAccountMetadata(ctx);
            ctx.Initialize(user.Concat(system));
            var overlay = new Entity("account", Guid.NewGuid())
            {
                ["name"] = "Valid",
                ["lastusedincampaign"] = new DateTime(2026, 9, 26, 0, 0, 0, DateTimeKind.Utc),
            };
            var service = new MetadataCountingService(ctx.GetOrganizationService());

            var outcome = new RulesEngineRunner().Run(
                service, service, "account",
                new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                RuleTrigger.OnDemand, RuleChannel.Standard, 1033, RootBuildMode.UseTarget,
                new XrmFakedTracingService(), new DateTime(2026, 9, 26, 12, 0, 0, DateTimeKind.Utc));

            Assert.True(outcome.IsValid);
            Assert.Equal(1, service.Retrieves["account"]);
        }

        [Fact]
        public void Run_evaluates_date_expressions_at_the_supplied_instant()
        {
            // name must be "Valid" (seeded) AND lastusedincampaign >= now - 1 day.
            var seed = Seed();
            AddDateCondition(seed);
            var ctx = new XrmFakedContext();
            InitializeAccountMetadata(ctx);
            ctx.Initialize(seed);
            var overlay = new Entity("account", Guid.NewGuid())
            {
                ["name"] = "Valid",
                ["lastusedincampaign"] = new DateTime(2026, 9, 26, 0, 0, 0, DateTimeKind.Utc),
            };
            var service = ctx.GetOrganizationService();
            RuleEvaluationOutcome RunAt(DateTime utcNow) => new RulesEngineRunner().Run(
                service, service, "account",
                new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                RuleTrigger.OnDemand, RuleChannel.Standard, 1033, RootBuildMode.UseTarget,
                new XrmFakedTracingService(), utcNow);

            Assert.True(RunAt(new DateTime(2026, 9, 26, 12, 0, 0, DateTimeKind.Utc)).IsValid);
            Assert.False(RunAt(new DateTime(2026, 12, 1, 0, 0, 0, DateTimeKind.Utc)).IsValid);
        }

        // ── Fires when ─────────────────────────────────────────────────────────

        [Theory]
        [InlineData("Invalid")]
        [InlineData("Valid")]
        public void Revision_whose_action_has_no_tree_fires_nothing_and_does_not_throw(string name)
        {
            // A published revision captured before its action had a "Fires when" tree: the action
            // never fires, whichever way the rule's one outcome goes.
            var id = Guid.NewGuid();
            var rows = RuleRevisionTests.Rule(id)
                .Where(r => r.LogicalName != Q(SchemaNames.ActionConditionGroup.Entity)
                         && r.LogicalName != Q(SchemaNames.ActionConditionTest.Entity))
                .ToList();
            var context = RuleRevisionTests.Context(rows);
            var service = context.GetOrganizationService();
            RuleRevisionTests.Freeze(service, id);

            RuleEvaluationOutcome outcome = null;
            var thrown = Record.Exception(() => outcome = new RulesEngineRunner().Run(service, service, "account",
                new List<RootInput> { new RootInput { Overlay = new Entity("account", Guid.NewGuid()) { ["name"] = name } } },
                RuleTrigger.OnDemand, RuleChannel.Standard, 1033, RootBuildMode.UseTarget, new XrmFakedTracingService()));

            Assert.Null(thrown);
            Assert.Equal(1, outcome.Diagnostics.RulesEvaluated);
            Assert.Empty(outcome.Records.Single().FiredActions);
            Assert.True(outcome.IsValid);
        }

        /// <summary>
        /// One account rule with two outcomes: "High value" (name = "Acme") and "At risk" (accountnumber =
        /// "RISK"). A1 Update description "both" when "High value" AND "At risk" (order 1); A2 Update
        /// description "high only" when "High value" AND NOT "At risk" (order 2); A3 ShowMessage "always"
        /// (order 3). <paramref name="withLater"/> adds A4 Update description "later" when "At risk"
        /// (order 4), the same column as A1. <paramref name="gated"/> adds an execution condition
        /// (name = "Never") that gates the rule out.
        /// </summary>
        private static List<Entity> OutcomeSeed(bool withLater = false, bool gated = false)
        {
            var ids = (rule: Guid.NewGuid(), cfg: Guid.NewGuid(), highValue: Guid.NewGuid(), atRisk: Guid.NewGuid());
            var rows = new List<Entity>
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
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnDemand) }),
                },
            };
            void Outcome(Guid groupId, string name, string column, string value)
            {
                rows.Add(new Entity(Q(SchemaNames.ConditionGroup.Entity), groupId)
                {
                    [Q(SchemaNames.PrimaryName)] = name,
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                });
                rows.Add(new Entity(Q(SchemaNames.RuleCondition.Entity), Guid.NewGuid())
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), groupId),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = column,
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                    [Q(SchemaNames.RuleCondition.ComparisonValue)] = value,
                });
            }
            Outcome(ids.highValue, "High value", "name", "Acme");
            Outcome(ids.atRisk, "At risk", "accountnumber", "RISK");
            if (gated)
            {
                // An execution condition no record in these tests meets: the rule never evaluates.
                var gate = Guid.NewGuid();
                rows.Add(new Entity(Q(SchemaNames.ConditionGroup.Entity), gate)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = true,
                });
                rows.Add(new Entity(Q(SchemaNames.RuleCondition.Entity), Guid.NewGuid())
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), gate),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                    [Q(SchemaNames.RuleCondition.ComparisonValue)] = "Never",
                });
            }

            Entity Action(ActionType type, int order, string description = null)
            {
                var action = new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid())
                {
                    [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)type),
                    [Q(SchemaNames.RuleAction.Order)] = order,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                };
                if (type == ActionType.ShowMessage) action[Q(SchemaNames.RuleAction.Message)] = "always";
                if (type == ActionType.UpdateRecord)
                {
                    action[Q(SchemaNames.RuleAction.TargetNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg);
                    action[Q(SchemaNames.RuleAction.FieldMapping)] =
                        "[{\"target\":\"description\",\"source\":\"literal\",\"value\":\"" + description + "\"}]";
                }
                rows.Add(action);
                return action;
            }

            var a1 = Action(ActionType.UpdateRecord, 1, "both");
            rows.AddRange(ActionTreeRows.AllTrue(a1.Id, ids.highValue, ids.atRisk));

            // HighValue AND NOT AtRisk: one ALL group with a "true" and a "false" test.
            var a2 = Action(ActionType.UpdateRecord, 2, "high only");
            var a2Tree = ActionTreeRows.AllTrue(a2.Id, ids.highValue);
            var notAtRisk = ActionTreeRows.AnyFalse(a2.Id, ids.atRisk).Single(r => r.LogicalName == Q(SchemaNames.ActionConditionTest.Entity));
            notAtRisk[Q(SchemaNames.ActionConditionTest.Group)] = a2Tree[0].ToEntityReference();
            notAtRisk[Q(SchemaNames.ActionConditionTest.Order)] = 2;
            a2Tree.Add(notAtRisk);
            rows.AddRange(a2Tree);

            var a3 = Action(ActionType.ShowMessage, 3);
            rows.AddRange(ActionTreeRows.Always(a3.Id));

            if (withLater)
            {
                var a4 = Action(ActionType.UpdateRecord, 4, "later");
                rows.AddRange(ActionTreeRows.AllTrue(a4.Id, ids.atRisk));
            }
            return rows;
        }

        private static XrmFakedContext OutcomeContext(List<Entity> seed)
        {
            var ctx = new XrmFakedContext();
            var accountMetadata = new EntityMetadata { LogicalName = "account" };
            typeof(EntityMetadata).GetProperty("Attributes").SetValue(accountMetadata, new AttributeMetadata[]
            {
                new StringAttributeMetadata { LogicalName = "name" },
                new StringAttributeMetadata { LogicalName = "accountnumber" },
                new StringAttributeMetadata { LogicalName = "description" },
            });
            ctx.InitializeMetadata(new List<EntityMetadata> { accountMetadata });
            ctx.Initialize(seed);
            return ctx;
        }

        // What each fired action did: the description it writes, or its message.
        private static string[] Fired(RecordEvaluationResult record) => record.FiredActions
            .Select(a => a.WriteIntent != null ? (string)a.WriteIntent.Values["description"] : a.Message)
            .ToArray();

        [Theory]
        [InlineData("Acme", "RISK", new[] { "both", "always" })]
        [InlineData("Acme", "SAFE", new[] { "high only", "always" })]
        [InlineData("Other", "RISK", new[] { "always" })]
        [InlineData("Other", "SAFE", new[] { "always" })]
        public void Each_action_fires_from_its_own_tree_over_the_rules_outcomes(string name, string accountNumber, string[] expected)
        {
            var ctx = OutcomeContext(OutcomeSeed());
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = name, ["accountnumber"] = accountNumber };

            var outcome = Run(ctx, overlay);

            Assert.Equal(expected, Fired(outcome.Records.Single()));
            Assert.True(outcome.IsValid);
        }

        [Fact]
        public void An_action_testing_only_the_second_outcome_fires_when_the_first_outcome_is_false()
        {
            // No short-circuit across outcomes: HighValue is false, AtRisk is still evaluated.
            var ctx = OutcomeContext(OutcomeSeed(withLater: true));
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Other", ["accountnumber"] = "RISK" };

            var record = Run(ctx, overlay).Records.Single();

            Assert.Equal(new[] { "always", "later" }, Fired(record));
        }

        [Fact]
        public void Two_fired_writes_to_one_column_merge_with_the_later_action_winning()
        {
            var ctx = OutcomeContext(OutcomeSeed(withLater: true));
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme", ["accountnumber"] = "RISK" };

            var record = Run(ctx, overlay).Records.Single();

            Assert.Equal(new[] { "both", "always", "later" }, Fired(record));
            var merged = ChangeSet.ForRecord(record, new RootRecord("account", overlay.Id));
            Assert.Equal("later", merged.RootInPlaceValues["description"]);
        }

        // ── Outcome values per record ──────────────────────────────────────────

        private static Guid OutcomeId(List<Entity> seed, string name) => seed.Single(e =>
            e.LogicalName == Q(SchemaNames.ConditionGroup.Entity) && e.GetAttributeValue<string>(Q(SchemaNames.PrimaryName)) == name).Id;

        [Fact]
        public void Each_record_reports_every_outcome_of_an_evaluated_rule_with_its_name_and_value()
        {
            var seed = OutcomeSeed();
            var ruleId = seed.Single(e => e.LogicalName == Q(SchemaNames.Rule.Entity)).Id;
            var ctx = OutcomeContext(seed);
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme", ["accountnumber"] = "SAFE" };

            var record = Run(ctx, overlay).Records.Single();

            Assert.Equal(
                new[] { (ruleId, OutcomeId(seed, "High value"), "High value", true), (ruleId, OutcomeId(seed, "At risk"), "At risk", false) },
                record.Outcomes.Select(o => (o.RuleId, o.OutcomeId, o.Name, o.Value)).ToArray());
        }

        [Fact]
        public void A_gated_rule_reports_no_outcomes()
        {
            var seed = OutcomeSeed(gated: true);
            var ruleId = seed.Single(e => e.LogicalName == Q(SchemaNames.Rule.Entity)).Id;
            var ctx = OutcomeContext(seed);
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme", ["accountnumber"] = "RISK" };

            var record = Run(ctx, overlay).Records.Single();

            Assert.Equal(new[] { ruleId }, record.GatedRuleIds.ToArray());
            Assert.Empty(record.Outcomes);
        }
    }
}
