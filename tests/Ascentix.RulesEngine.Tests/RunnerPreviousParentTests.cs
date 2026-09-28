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

        private static Entity Action(Guid id, Guid ruleId, Guid target, ActionFireOn fireOn, string mapping, bool tick, int order,
            ActionType type = ActionType.UpdateRecord)
        {
            var a = new Entity(Q(SchemaNames.RuleAction.Entity), id)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ruleId),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)type),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)fireOn),
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
            return a;
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
                Action(Guid.NewGuid(), ruleId, orderCfg, ActionFireOn.OnMatch,
                    "[{\"target\":\"sample_isexpedited\",\"source\":\"literal\",\"value\":true}]", tick: true, order: 1),
                Action(Guid.NewGuid(), ruleId, orderCfg, ActionFireOn.OnNoMatch,
                    "[{\"target\":\"sample_isexpedited\",\"source\":\"literal\",\"value\":false}]", tick: true, order: 2),
                // Not ticked, fires on no match: without the run-2 filter it would be written to order A.
                Action(Guid.NewGuid(), ruleId, orderCfg, ActionFireOn.OnNoMatch,
                    "[{\"target\":\"sample_approvalnotes\",\"source\":\"literal\",\"value\":\"line changed\"}]", tick: false, order: 3),
                // Not ticked Block on no match: must never fire for the previous order.
                Action(Guid.NewGuid(), ruleId, orderCfg, ActionFireOn.OnNoMatch, null, tick: false, order: 4, type: ActionType.Block),
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
                Action(Guid.NewGuid(), ruleId, orderCfg, ActionFireOn.OnMatch,
                    "[{\"target\":\"sample_isexpedited\",\"source\":\"literal\",\"value\":true}]", tick: true, order: 1),
                Action(Guid.NewGuid(), ruleId, orderCfg, ActionFireOn.OnNoMatch,
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
                Action(Guid.NewGuid(), ruleId2, orderCfg, ActionFireOn.OnNoMatch,
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
                Action(Guid.NewGuid(), ruleId, orderCfg, ActionFireOn.OnMatch,
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
                Action(Guid.NewGuid(), ruleId, customerCfg, ActionFireOn.OnMatch,
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
    }
}
