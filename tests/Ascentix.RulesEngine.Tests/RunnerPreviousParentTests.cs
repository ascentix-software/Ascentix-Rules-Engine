using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using CoreModels = Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// End to end through RulesEngineRunner: a line moves from order A to order B. The rule is
    /// rooted on the line, reads its order (lookup) and that order's lines (collection), and
    /// passes when the order has at least two lines. Run 1 evaluates order B; run 2 evaluates
    /// order A and fires only the ticked actions.
    /// </summary>
    public class RunnerPreviousParentTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private sealed class MetadataService : IOrganizationService
        {
            private readonly IOrganizationService _inner;
            public MetadataService(IOrganizationService inner) { _inner = inner; }

            public OrganizationResponse Execute(OrganizationRequest request)
            {
                if (request is RetrieveEntityRequest req && req.LogicalName == "sample_order")
                {
                    var meta = new EntityMetadata { LogicalName = "sample_order" };
                    typeof(EntityMetadata).GetProperty("Attributes").SetValue(meta, new AttributeMetadata[]
                    {
                        new BooleanAttributeMetadata { LogicalName = "sample_isexpedited" },
                        new MemoAttributeMetadata { LogicalName = "sample_approvalnotes" },
                        new DateTimeAttributeMetadata { LogicalName = "sample_orderdate" },
                        new DateTimeAttributeMetadata { LogicalName = "sample_duedate" },
                    });
                    return new RetrieveEntityResponse { Results = new ParameterCollection { { "EntityMetadata", meta } } };
                }
                if (request is RetrieveEntityRequest creq && creq.LogicalName == "sample_customer")
                {
                    var meta = new EntityMetadata { LogicalName = "sample_customer" };
                    typeof(EntityMetadata).GetProperty("Attributes").SetValue(meta, new AttributeMetadata[]
                    {
                        new BooleanAttributeMetadata { LogicalName = "sample_ispriority" },
                    });
                    return new RetrieveEntityResponse { Results = new ParameterCollection { { "EntityMetadata", meta } } };
                }
                return _inner.Execute(request);
            }

            public Guid Create(Entity entity) => _inner.Create(entity);
            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => _inner.Retrieve(entityName, id, columnSet);
            public void Update(Entity entity) => _inner.Update(entity);
            public void Delete(string entityName, Guid id) => _inner.Delete(entityName, id);
            public EntityCollection RetrieveMultiple(QueryBase query) => _inner.RetrieveMultiple(query);
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => _inner.Associate(entityName, entityId, relationship, relatedEntities);
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => _inner.Disassociate(entityName, entityId, relationship, relatedEntities);
        }

        // "Fires when" trees as row builders for one action id.
        private static Func<Guid, List<Entity>> AllTrue(params Guid[] outcomes) => id => ActionTreeRows.AllTrue(id, outcomes);
        private static Func<Guid, List<Entity>> AnyFalse(params Guid[] outcomes) => id => ActionTreeRows.AnyFalse(id, outcomes);
        private static Func<Guid, List<Entity>> Always() => ActionTreeRows.Always;

        /// <summary>The action row followed by its "Fires when" tree rows.</summary>
        private static List<Entity> Action(Guid id, Guid ruleId, Guid target, Func<Guid, List<Entity>> when, string mapping, bool tick, int order,
            ActionType type = ActionType.UpdateRecord)
        {
            var a = new Entity(Q(SchemaNames.RuleAction.Entity), id)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)type),
                [Q(SchemaNames.RuleAction.IsActive)] = true,
                [Q(SchemaNames.RuleAction.Order)] = order,
                [Q(SchemaNames.RuleAction.ApplyToPrevious)] = tick,
            };
            if (type == ActionType.UpdateRecord)
            {
                a[Q(SchemaNames.RuleAction.TargetNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), target);
                a[Q(SchemaNames.RuleAction.FieldMapping)] = mapping;
            }
            else
            {
                a[Q(SchemaNames.RuleAction.Message)] = "blocked";
            }
            var rows = new List<Entity> { a };
            rows.AddRange(when(id));
            return rows;
        }

        [Fact]
        public void Moving_a_line_recalculates_both_orders_with_only_ticked_actions_for_the_previous_one()
        {
            Guid ruleId = Guid.NewGuid(), rootCfg = Guid.NewGuid(), orderCfg = Guid.NewGuid(), siblingsCfg = Guid.NewGuid();
            Guid grp = Guid.NewGuid(), cond = Guid.NewGuid();
            Guid orderA = Guid.NewGuid(), orderB = Guid.NewGuid();
            Guid line1 = Guid.NewGuid(), line2 = Guid.NewGuid(), line3 = Guid.NewGuid();

            EntityReference Cfg(Guid id) => new EntityReference(Q(SchemaNames.TableConfig.Entity), id);
            Entity Line(Guid id, Guid order) => new Entity("sample_orderline", id)
                { ["sample_orderid"] = new EntityReference("sample_order", order), ["sample_name"] = id.ToString() };

            var seed = new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), orderCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(rootCfg),
                    [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "sample_orderid",
                    [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), siblingsCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(orderCfg),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_orderline",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grp)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), cond)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grp),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = Cfg(siblingsCfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.RowCount),
                    [Q(SchemaNames.RuleCondition.MinExpectedRows)] = 2,
                },
                // Ticked: the order's expedite flag follows the rule, for both orders.
                Action(Guid.NewGuid(), ruleId, orderCfg, AllTrue(grp),
                    "[{\"target\":\"sample_isexpedited\",\"source\":\"literal\",\"value\":true}]", tick: true, order: 1),
                Action(Guid.NewGuid(), ruleId, orderCfg, AnyFalse(grp),
                    "[{\"target\":\"sample_isexpedited\",\"source\":\"literal\",\"value\":false}]", tick: true, order: 2),
                // Not ticked, fires when the outcome is false: without the run-2 filter it would be written to order A.
                Action(Guid.NewGuid(), ruleId, orderCfg, AnyFalse(grp),
                    "[{\"target\":\"sample_approvalnotes\",\"source\":\"literal\",\"value\":\"line changed\"}]", tick: false, order: 3),
                // Not ticked Block when the outcome is false: must never fire for the previous order.
                Action(Guid.NewGuid(), ruleId, orderCfg, AnyFalse(grp), null, tick: false, order: 4, type: ActionType.Block),
                new Entity("sample_order", orderA),
                new Entity("sample_order", orderB),
                Line(line1, orderA),
                Line(line2, orderA),   // the line being moved; still on A in the database
                Line(line3, orderB),
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);
            var service = new MetadataService(ctx.GetOrganizationService());

            // Move line 2 from A to B: after the save, B has lines 2 and 3 (pass), A has line 1 (no match).
            var overlay = new Entity("sample_orderline", line2) { ["sample_orderid"] = new EntityReference("sample_order", orderB) };
            var outcome = new RulesEngineRunner().Run(
                systemService: service,
                userService: service,
                logicalName: "sample_orderline",
                inputs: new List<RootInput> { new RootInput { Id = line2, Overlay = overlay } },
                trigger: RuleTrigger.OnUpdate,
                channel: RuleChannel.Standard,
                languageId: 1033,
                buildMode: RootBuildMode.RetrieveAndOverlay,
                trace: new XrmFakedTracingService());

            var fired = outcome.Records[0].FiredActions;
            var forB = fired.Where(a => a.PreviousOfNodeId == null).ToList();
            var forA = fired.Where(a => a.PreviousOfNodeId == orderCfg).ToList();

            // Run 1, order B: two lines → match → expedite true. No-match actions do not fire.
            var bWrite = Assert.Single(forB);
            Assert.Equal(orderB, bWrite.WriteIntent.TargetId);
            Assert.Equal(true, bWrite.WriteIntent.Values["sample_isexpedited"]);

            // Run 2, order A: one line → no match → only the ticked expedite=false; no note, no block.
            var aWrite = Assert.Single(forA);
            Assert.Equal(ActionType.UpdateRecord, aWrite.ActionType);
            Assert.Equal(orderA, aWrite.WriteIntent.TargetId);
            Assert.Equal(false, aWrite.WriteIntent.Values["sample_isexpedited"]);
            Assert.False(outcome.Records[0].HasBlock);
        }

        [Fact]
        public void Run_2_contributes_nothing_for_a_rule_with_no_ticked_action_for_the_changed_lookup()
        {
            // Same shape as the first test (a line moves from A to B), plus a second rule in the
            // same bucket whose only action targeting the order node is UNTICKED. BucketEvaluator
            // now skips evaluating a rule's conditions in run 2 unless it has an eligible ticked
            // action for that lookup (see BucketEvaluator.HasPreviousAction); this asserts the
            // resulting behavior: rule 2 fires nothing at all, and rule 1's run-2 result is exactly
            // as in the single-rule scenario. Proving the conditions themselves are never
            // evaluated would need an evaluation that throws when reached, which nothing in this
            // harness can force without also breaking rule 1's own evaluation (the tree/plan is
            // shared across every rule in the bucket) — so this is the observable half of the
            // fix, backed by the code comment at the skip site.
            Guid ruleId = Guid.NewGuid(), ruleId2 = Guid.NewGuid();
            Guid rootCfg = Guid.NewGuid(), orderCfg = Guid.NewGuid(), siblingsCfg = Guid.NewGuid();
            Guid grp = Guid.NewGuid(), cond = Guid.NewGuid(), grp2 = Guid.NewGuid(), cond2 = Guid.NewGuid();
            Guid orderA = Guid.NewGuid(), orderB = Guid.NewGuid();
            Guid line1 = Guid.NewGuid(), line2 = Guid.NewGuid(), line3 = Guid.NewGuid();

            EntityReference Cfg(Guid id) => new EntityReference(Q(SchemaNames.TableConfig.Entity), id);
            Entity Line(Guid id, Guid order) => new Entity("sample_orderline", id)
                { ["sample_orderid"] = new EntityReference("sample_order", order), ["sample_name"] = id.ToString() };

            var seed = new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), orderCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(rootCfg),
                    [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "sample_orderid",
                    [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), siblingsCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(orderCfg),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
                },
                // Rule 1: ticked expedite actions, as in the base scenario.
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_orderline",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grp)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), cond)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grp),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = Cfg(siblingsCfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.RowCount),
                    [Q(SchemaNames.RuleCondition.MinExpectedRows)] = 2,
                },
                Action(Guid.NewGuid(), ruleId, orderCfg, AllTrue(grp),
                    "[{\"target\":\"sample_isexpedited\",\"source\":\"literal\",\"value\":true}]", tick: true, order: 1),
                Action(Guid.NewGuid(), ruleId, orderCfg, AnyFalse(grp),
                    "[{\"target\":\"sample_isexpedited\",\"source\":\"literal\",\"value\":false}]", tick: true, order: 2),

                // Rule 2: same bucket, own condition group, only an UNTICKED Update Record action
                // on the same order node — without the run-2 filter it would still never fire
                // (the per-action check already excludes unticked actions), so what this proves
                // is that adding a rule with nothing eligible for the changed lookup leaves rule
                // 1's run-2 result untouched and contributes no fired actions of its own.
                new Entity(Q(SchemaNames.Rule.Entity), ruleId2)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_orderline",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grp2)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId2),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), cond2)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grp2),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = Cfg(siblingsCfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.RowCount),
                    [Q(SchemaNames.RuleCondition.MinExpectedRows)] = 2,
                },
                Action(Guid.NewGuid(), ruleId2, orderCfg, AnyFalse(grp2),
                    "[{\"target\":\"sample_approvalnotes\",\"source\":\"literal\",\"value\":\"should never apply\"}]",
                    tick: false, order: 1),

                new Entity("sample_order", orderA),
                new Entity("sample_order", orderB),
                Line(line1, orderA),
                Line(line2, orderA),   // the line being moved; still on A in the database
                Line(line3, orderB),
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);
            var service = new MetadataService(ctx.GetOrganizationService());

            // Move line 2 from A to B: after the save, B has lines 2 and 3 (pass), A has line 1 (no match).
            var overlay = new Entity("sample_orderline", line2) { ["sample_orderid"] = new EntityReference("sample_order", orderB) };
            var outcome = new RulesEngineRunner().Run(
                systemService: service,
                userService: service,
                logicalName: "sample_orderline",
                inputs: new List<RootInput> { new RootInput { Id = line2, Overlay = overlay } },
                trigger: RuleTrigger.OnUpdate,
                channel: RuleChannel.Standard,
                languageId: 1033,
                buildMode: RootBuildMode.RetrieveAndOverlay,
                trace: new XrmFakedTracingService());

            var fired = outcome.Records[0].FiredActions;
            var forA = fired.Where(a => a.PreviousOfNodeId == orderCfg).ToList();

            // Rule 2 fires nothing anywhere (run 1 or run 2): its only action is unticked.
            Assert.DoesNotContain(fired, a => a.RuleId == ruleId2);

            // Rule 1's run-2 result is exactly as in the single-rule scenario.
            var aWrite = Assert.Single(forA);
            Assert.Equal(ruleId, aWrite.RuleId);
            Assert.Equal(orderA, aWrite.WriteIntent.TargetId);
            Assert.Equal(false, aWrite.WriteIntent.Values["sample_isexpedited"]);
        }

        [Fact]
        public void Without_a_lookup_change_there_is_no_second_run()
        {
            // Same seed shape, but the save changes only the line's name.
            Guid ruleId = Guid.NewGuid(), rootCfg = Guid.NewGuid(), orderCfg = Guid.NewGuid();
            Guid orderA = Guid.NewGuid(), line = Guid.NewGuid();
            var seed = new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), orderCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootCfg),
                    [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "sample_orderid",
                    [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_orderline",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                Action(Guid.NewGuid(), ruleId, orderCfg, Always(),
                    "[{\"target\":\"sample_isexpedited\",\"source\":\"literal\",\"value\":true}]", tick: true, order: 1),
                new Entity("sample_order", orderA),
                new Entity("sample_orderline", line) { ["sample_orderid"] = new EntityReference("sample_order", orderA) },
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);
            var service = new MetadataService(ctx.GetOrganizationService());

            var overlay = new Entity("sample_orderline", line) { ["sample_name"] = "renamed" };
            var outcome = new RulesEngineRunner().Run(
                systemService: service, userService: service, logicalName: "sample_orderline",
                inputs: new List<RootInput> { new RootInput { Id = line, Overlay = overlay } },
                trigger: RuleTrigger.OnUpdate, channel: RuleChannel.Standard, languageId: 1033,
                buildMode: RootBuildMode.RetrieveAndOverlay, trace: new XrmFakedTracingService());

            Assert.DoesNotContain(outcome.Records[0].FiredActions, a => a.PreviousOfNodeId != null);
        }

        [Fact]
        public void A_record_both_orders_share_is_written_by_the_normal_run_only()
        {
            // Line → Order → Customer; the line moves between two orders of the same customer. The
            // ticked action targets the customer, which run 2 resolves to the same, still current,
            // record: run 1 owns it, so run 2 must not write it again.
            Guid ruleId = Guid.NewGuid(), rootCfg = Guid.NewGuid(), orderCfg = Guid.NewGuid(), customerCfg = Guid.NewGuid();
            Guid customer = Guid.NewGuid(), orderA = Guid.NewGuid(), orderB = Guid.NewGuid(), line = Guid.NewGuid();
            EntityReference Cfg(Guid id) => new EntityReference(Q(SchemaNames.TableConfig.Entity), id);
            Entity Order(Guid id) => new Entity("sample_order", id)
                { ["sample_customerid"] = new EntityReference("sample_customer", customer) };

            var seed = new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), orderCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(rootCfg),
                    [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "sample_orderid",
                    [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), customerCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_customer",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(orderCfg),
                    [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "sample_customerid",
                    [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "sample_customerid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_orderline",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                Action(Guid.NewGuid(), ruleId, customerCfg, Always(),
                    "[{\"target\":\"sample_ispriority\",\"source\":\"literal\",\"value\":true}]", tick: true, order: 1),
                new Entity("sample_customer", customer),
                Order(orderA),
                Order(orderB),
                new Entity("sample_orderline", line) { ["sample_orderid"] = new EntityReference("sample_order", orderA) },
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);
            var service = new MetadataService(ctx.GetOrganizationService());

            var overlay = new Entity("sample_orderline", line) { ["sample_orderid"] = new EntityReference("sample_order", orderB) };
            var outcome = new RulesEngineRunner().Run(
                systemService: service, userService: service, logicalName: "sample_orderline",
                inputs: new List<RootInput> { new RootInput { Id = line, Overlay = overlay } },
                trigger: RuleTrigger.OnUpdate, channel: RuleChannel.Standard, languageId: 1033,
                buildMode: RootBuildMode.RetrieveAndOverlay, trace: new XrmFakedTracingService());

            var fired = outcome.Records[0].FiredActions;
            Assert.DoesNotContain(fired, a => a.PreviousOfNodeId != null);
            var write = Assert.Single(fired);
            Assert.Equal(customer, write.WriteIntent.TargetId);
            Assert.Equal(true, write.WriteIntent.Values["sample_ispriority"]);
        }

        [Fact]
        public void Run_2_reads_the_previous_orders_date_not_the_new_ones()
        {
            // A FieldComparison condition anchored on the Order lookup: order.sample_orderdate
            // >= order.sample_duedate + 1 day (DateExpression anchor, same node, different
            // column). Order A's dates make this false; order B's make it true — so run 1
            // (order B) fires the "outcome true" action and run 2 (order A, the previous parent) fires
            // the "outcome false" one instead, proving run 2 resolves both the comparison column and the
            // anchor against A, not B.
            Guid ruleId = Guid.NewGuid(), rootCfg = Guid.NewGuid(), orderCfg = Guid.NewGuid();
            Guid grp = Guid.NewGuid(), cond = Guid.NewGuid();
            Guid orderA = Guid.NewGuid(), orderB = Guid.NewGuid(), line = Guid.NewGuid();

            EntityReference Cfg(Guid id) => new EntityReference(Q(SchemaNames.TableConfig.Entity), id);

            var seed = new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), orderCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(rootCfg),
                    [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "sample_orderid",
                    [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_orderline",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grp)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), cond)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grp),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = Cfg(orderCfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "sample_orderdate",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.GreaterThanOrEqual),
                    [Q(SchemaNames.RuleCondition.ComparisonValueSource)] = new OptionSetValue((int)ComparisonValueSource.DateExpression),
                    [Q(SchemaNames.RuleCondition.ComparisonValue)] =
                        "{\"anchor\":{\"kind\":\"field\",\"node\":\"" + orderCfg + "\",\"column\":\"sample_duedate\"},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}",
                },
                Action(Guid.NewGuid(), ruleId, orderCfg, AllTrue(grp),
                    "[{\"target\":\"sample_approvalnotes\",\"source\":\"literal\",\"value\":\"matched\"}]", tick: true, order: 1),
                Action(Guid.NewGuid(), ruleId, orderCfg, AnyFalse(grp),
                    "[{\"target\":\"sample_approvalnotes\",\"source\":\"literal\",\"value\":\"no-match\"}]", tick: true, order: 2),
                new Entity("sample_order", orderA)
                {
                    ["sample_orderdate"] = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
                    ["sample_duedate"] = new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc),
                },
                new Entity("sample_order", orderB)
                {
                    ["sample_orderdate"] = new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc),
                    ["sample_duedate"] = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
                },
                new Entity("sample_orderline", line) { ["sample_orderid"] = new EntityReference("sample_order", orderA), ["sample_name"] = line.ToString() },
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);
            var service = new MetadataService(ctx.GetOrganizationService());

            var overlay = new Entity("sample_orderline", line) { ["sample_orderid"] = new EntityReference("sample_order", orderB) };
            var outcome = new RulesEngineRunner().Run(
                systemService: service, userService: service, logicalName: "sample_orderline",
                inputs: new List<RootInput> { new RootInput { Id = line, Overlay = overlay } },
                trigger: RuleTrigger.OnUpdate, channel: RuleChannel.Standard, languageId: 1033,
                buildMode: RootBuildMode.RetrieveAndOverlay, trace: new XrmFakedTracingService());

            var fired = outcome.Records[0].FiredActions;
            var forB = fired.Where(a => a.PreviousOfNodeId == null).ToList();
            var forA = fired.Where(a => a.PreviousOfNodeId == orderCfg).ToList();

            // Run 1, order B: orderdate (June) >= duedate + 1 day (Jan 2) → match → "matched".
            var bWrite = Assert.Single(forB);
            Assert.Equal(orderB, bWrite.WriteIntent.TargetId);
            Assert.Equal("matched", bWrite.WriteIntent.Values["sample_approvalnotes"]);

            // Run 2, order A: orderdate (Jan) >= duedate + 1 day (June 2) → no match → "no-match".
            // If the anchor or the comparison column leaked order B's dates into run 2, this
            // would fire "matched" instead.
            var aWrite = Assert.Single(forA);
            Assert.Equal(orderA, aWrite.WriteIntent.TargetId);
            Assert.Equal("no-match", aWrite.WriteIntent.Values["sample_approvalnotes"]);
        }

        [Fact]
        public void Two_lookups_changing_in_one_save_each_get_their_own_previous_parent_run()
        {
            // Root line with two root-level lookups: Order (sample_orderid) and Customer
            // (sample_customerid), each with its own ticked Update Record action. One save
            // changes both. Each changed lookup gets its own run 2, and each fires only the
            // action targeting that lookup — never the other lookup's action.
            Guid ruleId = Guid.NewGuid(), rootCfg = Guid.NewGuid(), orderCfg = Guid.NewGuid(), customerCfg = Guid.NewGuid();
            Guid orderA = Guid.NewGuid(), orderB = Guid.NewGuid(), custX = Guid.NewGuid(), custY = Guid.NewGuid(), line = Guid.NewGuid();

            EntityReference Cfg(Guid id) => new EntityReference(Q(SchemaNames.TableConfig.Entity), id);

            var seed = new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), orderCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(rootCfg),
                    [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "sample_orderid",
                    [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "sample_orderid",
                },
                // A second root-level lookup, sibling of the order lookup: the line's customer.
                new Entity(Q(SchemaNames.TableConfig.Entity), customerCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_customer",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(rootCfg),
                    [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "sample_customerid",
                    [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "sample_customerid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_orderline",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                // Ticked: each action targets a different one of the two lookups.
                Action(Guid.NewGuid(), ruleId, orderCfg, Always(),
                    "[{\"target\":\"sample_approvalnotes\",\"source\":\"literal\",\"value\":\"order touched\"}]", tick: true, order: 1),
                Action(Guid.NewGuid(), ruleId, customerCfg, Always(),
                    "[{\"target\":\"sample_ispriority\",\"source\":\"literal\",\"value\":true}]", tick: true, order: 2),
                new Entity("sample_order", orderA),
                new Entity("sample_order", orderB),
                new Entity("sample_customer", custX),
                new Entity("sample_customer", custY),
                new Entity("sample_orderline", line)
                {
                    ["sample_orderid"] = new EntityReference("sample_order", orderA),
                    ["sample_customerid"] = new EntityReference("sample_customer", custX),
                    ["sample_name"] = line.ToString(),
                },
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);
            var service = new MetadataService(ctx.GetOrganizationService());

            // One save changes BOTH lookups: order A → B, customer X → Y.
            var overlay = new Entity("sample_orderline", line)
            {
                ["sample_orderid"] = new EntityReference("sample_order", orderB),
                ["sample_customerid"] = new EntityReference("sample_customer", custY),
            };
            var outcome = new RulesEngineRunner().Run(
                systemService: service, userService: service, logicalName: "sample_orderline",
                inputs: new List<RootInput> { new RootInput { Id = line, Overlay = overlay } },
                trigger: RuleTrigger.OnUpdate, channel: RuleChannel.Standard, languageId: 1033,
                buildMode: RootBuildMode.RetrieveAndOverlay, trace: new XrmFakedTracingService());

            var fired = outcome.Records[0].FiredActions;
            var forOrder = fired.Where(a => a.PreviousOfNodeId == orderCfg).ToList();
            var forCustomer = fired.Where(a => a.PreviousOfNodeId == customerCfg).ToList();

            // Run 2 for the order lookup: only the order-targeted action, against order A.
            var orderWrite = Assert.Single(forOrder);
            Assert.Equal(orderA, orderWrite.WriteIntent.TargetId);
            Assert.Equal("order touched", orderWrite.WriteIntent.Values["sample_approvalnotes"]);

            // Run 2 for the customer lookup: only the customer-targeted action, against customer X.
            var customerWrite = Assert.Single(forCustomer);
            Assert.Equal(custX, customerWrite.WriteIntent.TargetId);
            Assert.Equal(true, customerWrite.WriteIntent.Values["sample_ispriority"]);
        }

        [Fact]
        public void Bulk_save_gives_each_record_its_own_previous_parent_run()
        {
            // Two RootInputs in one call (the UpdateMultiple shape): line2 moves from order A to
            // B, as in the single-record test above; line4, on an unrelated order C, only has its
            // name changed. Assert per record: record 0 gets run-2 results for order A only,
            // record 1 gets none, and the moved line is counted under B (not A) for the
            // RowCount>=2 match — the same rule as the single-record test above.
            Guid ruleId = Guid.NewGuid(), rootCfg = Guid.NewGuid(), orderCfg = Guid.NewGuid(), siblingsCfg = Guid.NewGuid();
            Guid grp = Guid.NewGuid(), cond = Guid.NewGuid();
            Guid orderA = Guid.NewGuid(), orderB = Guid.NewGuid(), orderC = Guid.NewGuid();
            Guid line1 = Guid.NewGuid(), line2 = Guid.NewGuid(), line3 = Guid.NewGuid(), line4 = Guid.NewGuid();

            EntityReference Cfg(Guid id) => new EntityReference(Q(SchemaNames.TableConfig.Entity), id);
            Entity Line(Guid id, Guid order) => new Entity("sample_orderline", id)
                { ["sample_orderid"] = new EntityReference("sample_order", order), ["sample_name"] = id.ToString() };

            var seed = new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), rootCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), orderCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(rootCfg),
                    [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "sample_orderid",
                    [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), siblingsCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Cfg(orderCfg),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_orderline",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnUpdate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), grp)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), cond)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), grp),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = Cfg(siblingsCfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.RowCount),
                    [Q(SchemaNames.RuleCondition.MinExpectedRows)] = 2,
                },
                Action(Guid.NewGuid(), ruleId, orderCfg, AllTrue(grp),
                    "[{\"target\":\"sample_isexpedited\",\"source\":\"literal\",\"value\":true}]", tick: true, order: 1),
                Action(Guid.NewGuid(), ruleId, orderCfg, AnyFalse(grp),
                    "[{\"target\":\"sample_isexpedited\",\"source\":\"literal\",\"value\":false}]", tick: true, order: 2),
                new Entity("sample_order", orderA),
                new Entity("sample_order", orderB),
                new Entity("sample_order", orderC),
                Line(line1, orderA),
                Line(line2, orderA),   // moving to B
                Line(line3, orderB),
                Line(line4, orderC),   // unrelated rename only
            };
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);
            var service = new MetadataService(ctx.GetOrganizationService());

            var moveOverlay = new Entity("sample_orderline", line2) { ["sample_orderid"] = new EntityReference("sample_order", orderB) };
            var renameOverlay = new Entity("sample_orderline", line4) { ["sample_name"] = "renamed" };
            var outcome = new RulesEngineRunner().Run(
                systemService: service,
                userService: service,
                logicalName: "sample_orderline",
                inputs: new List<RootInput>
                {
                    new RootInput { Id = line2, Overlay = moveOverlay },
                    new RootInput { Id = line4, Overlay = renameOverlay },
                },
                trigger: RuleTrigger.OnUpdate,
                channel: RuleChannel.Standard,
                languageId: 1033,
                buildMode: RootBuildMode.RetrieveAndOverlay,
                trace: new XrmFakedTracingService());

            // Record 0 (the move): run-2 fires only for order A, and only the ticked no-match action.
            var record0 = outcome.Records[0].FiredActions;
            var record0PreviousRuns = record0.Where(a => a.PreviousOfNodeId != null).ToList();
            var aWrite = Assert.Single(record0PreviousRuns);
            Assert.Equal(orderCfg, aWrite.PreviousOfNodeId);
            Assert.Equal(orderA, aWrite.WriteIntent.TargetId);
            Assert.Equal(false, aWrite.WriteIntent.Values["sample_isexpedited"]);

            // Order B now has two lines (2 and 3): the normal run matches and expedites B, not A.
            var record0Normal = record0.Where(a => a.PreviousOfNodeId == null).ToList();
            var bWrite = Assert.Single(record0Normal);
            Assert.Equal(orderB, bWrite.WriteIntent.TargetId);
            Assert.Equal(true, bWrite.WriteIntent.Values["sample_isexpedited"]);

            // Record 1 (the unrelated rename): no lookup changed, so no run-2 at all.
            var record1 = outcome.Records[1].FiredActions;
            Assert.DoesNotContain(record1, a => a.PreviousOfNodeId != null);
        }
    }
}
