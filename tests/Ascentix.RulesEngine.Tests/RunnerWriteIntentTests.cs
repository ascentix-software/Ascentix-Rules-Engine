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
    /// End-to-end through <see cref="RulesEngineRunner.Run"/>: the facts that prove the GATHER
    /// stage seeds a node into the config load / query plan because an action or condition
    /// references it (a lookup write target, a mapping aggregate, an execution-condition
    /// expression), so the write intent resolves against rows that were actually fetched.
    /// The verdict-only facts (a fired action's WriteIntent shape, mathexpr coercion, the
    /// execution gate's negative) live at the evaluation seam in
    /// Engine/RuleEvaluationTableTests.
    ///
    /// The fake service wraps XrmFakedContext's service and intercepts Execute to answer
    /// RetrieveEntityRequest per table with attribute metadata.
    /// </summary>
    public class RunnerWriteIntentTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // ── Lookup-aware fake service ─────────────────────────────────────────────

        /// <summary>
        /// Serves attribute metadata for the given tables (plus task.subject → String) and
        /// returns a pre-registered Entity when Retrieve is called for a specific id.
        /// Used to simulate lookup-node traversal in the lookup-node tests.
        /// </summary>
        private sealed class ExtendedFakeService : IOrganizationService
        {
            private readonly IOrganizationService _inner;
            private readonly Dictionary<string, AttributeMetadata[]> _metaByTable;
            private readonly Dictionary<(string, Guid), Entity> _retrieveMap;

            public ExtendedFakeService(
                IOrganizationService inner,
                Dictionary<string, AttributeMetadata[]> metaByTable = null,
                Dictionary<(string, Guid), Entity> retrieveMap = null)
            {
                _inner = inner;
                _metaByTable = metaByTable ?? new Dictionary<string, AttributeMetadata[]>();
                _retrieveMap = retrieveMap ?? new Dictionary<(string, Guid), Entity>();
            }

            public OrganizationResponse Execute(OrganizationRequest request)
            {
                if (request is RetrieveEntityRequest req && _metaByTable.TryGetValue(req.LogicalName, out var attrs))
                {
                    var entityMeta = new EntityMetadata { LogicalName = req.LogicalName };
                    var attrsProp = typeof(EntityMetadata).GetProperty("Attributes");
                    if (attrsProp != null)
                        attrsProp.SetValue(entityMeta, attrs);
                    else
                    {
                        var field = typeof(EntityMetadata).GetField("_attributes",
                            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                        field?.SetValue(entityMeta, attrs);
                    }
                    return new RetrieveEntityResponse
                    {
                        Results = new ParameterCollection { { "EntityMetadata", entityMeta } }
                    };
                }
                // Fall back to existing task metadata handler
                if (request is RetrieveEntityRequest taskReq && taskReq.LogicalName == "task")
                {
                    var subjectAttr = new StringAttributeMetadata { LogicalName = "subject" };
                    var entityMeta = new EntityMetadata { LogicalName = "task" };
                    var attrsProp = typeof(EntityMetadata).GetProperty("Attributes");
                    if (attrsProp != null)
                        attrsProp.SetValue(entityMeta, new AttributeMetadata[] { subjectAttr });
                    return new RetrieveEntityResponse
                    {
                        Results = new ParameterCollection { { "EntityMetadata", entityMeta } }
                    };
                }
                return _inner.Execute(request);
            }

            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet)
            {
                if (_retrieveMap.TryGetValue((entityName, id), out var e))
                    return e;
                return _inner.Retrieve(entityName, id, columnSet);
            }

            public Guid Create(Entity entity) => _inner.Create(entity);
            public void Update(Entity entity) => _inner.Update(entity);
            public void Delete(string entityName, Guid id) => _inner.Delete(entityName, id);
            public EntityCollection RetrieveMultiple(QueryBase query) => _inner.RetrieveMultiple(query);
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => _inner.Associate(entityName, entityId, relationship, relatedEntities);
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => _inner.Disassociate(entityName, entityId, relationship, relatedEntities);
        }

        /// <summary>
        /// UpdateRecord action targets a lookup node (contact via primarycontactid)
        /// that NO condition references. The config tree must still be loaded and traversed
        /// so the WriteIntent can resolve the related contact record.
        /// </summary>
        [Fact]
        public void UpdateRecord_on_lookup_node_not_referenced_by_condition_resolves_write_intent()
        {
            var ids = (
                rule: Guid.NewGuid(),
                rootCfg: Guid.NewGuid(),
                lookupCfg: Guid.NewGuid(),
                grp: Guid.NewGuid(),
                cond: Guid.NewGuid(),
                act: Guid.NewGuid()
            );
            var contactId = Guid.NewGuid();

            // Root TableConfig: account
            var rootTableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.rootCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            // Lookup TableConfig: contact via primarycontactid (no condition references this)
            var lookupTableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.lookupCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "contact",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.rootCfg),
                [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "primarycontactid",
                [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "contactid",
            };
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ids.rule)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
            };
            // Condition on the ROOT node (not the lookup node), always-true (name IsNotNull)
            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
            };
            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), ids.cond)
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.rootCfg),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.IsNotNull),
            };
            // UpdateRecord action targeting the LOOKUP node (contact). No condition references this node
            var action = new Entity(Q(SchemaNames.RuleAction.Entity), ids.act)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.UpdateRecord),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                [Q(SchemaNames.RuleAction.TargetNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.lookupCfg),
                [Q(SchemaNames.RuleAction.FieldMapping)] = "[{\"target\":\"lastname\",\"source\":\"literal\",\"value\":\"Updated\"}]",
                [Q(SchemaNames.RuleAction.IsActive)] = true,
                [Q(SchemaNames.RuleAction.Order)] = 1,
            };

            // The related contact record (returned by RetrieveMultiple IN-query via FakeXrmEasy)
            var contactEntity = new Entity("contact", contactId) { ["lastname"] = "Smith" };

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { rootTableConfig, lookupTableConfig, rule, group, condition, action, contactEntity });

            // Account root: has primarycontactid pointing to the contact
            var overlay = new Entity("account", Guid.NewGuid())
            {
                ["name"] = "Acme Corp",
                ["primarycontactid"] = new EntityReference("contact", contactId)
            };

            var inner = ctx.GetOrganizationService();
            var service = new ExtendedFakeService(
                inner,
                metaByTable: new Dictionary<string, AttributeMetadata[]>
                {
                    ["contact"] = new AttributeMetadata[] { new StringAttributeMetadata { LogicalName = "lastname" } }
                },
                retrieveMap: new Dictionary<(string, Guid), Entity>
                {
                    [("contact", contactId)] = contactEntity
                });

            var outcome = new RulesEngineRunner().Run(
                systemService: service,
                userService: service,
                logicalName: "account",
                inputs: new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                trigger: RuleTrigger.OnCreate,
                channel: RuleChannel.Standard,
                languageId: 1033,
                buildMode: RootBuildMode.UseTarget,
                trace: new XrmFakedTracingService());

            var fired = outcome.Records[0].FiredActions.Single(a => a.ActionType == ActionType.UpdateRecord);
            Assert.NotNull(fired.WriteIntent);
            Assert.Equal(WriteOperation.Update, fired.WriteIntent.Operation);
            Assert.Equal("contact", fired.WriteIntent.TargetTable);
            Assert.Equal(contactId, fired.WriteIntent.TargetId);
            Assert.False(fired.WriteIntent.RootTargeted);
        }

        /// <summary>
        /// Aggregate end-to-end: a rule on sample_order (OnCreate, always-true) has a CreateRecord
        /// action whose mapping is sum(node:&lt;child&gt;.lineamount) over a sample_orderline child
        /// node. The child node is seeded into the query plan solely because the aggregate's
        /// mathexpr references it (FieldMappingReferences.NodeIds → ExtractRefs).
        /// No condition touches the child. Two orderline rows are queried/cached via the real
        /// FakeXrmEasy engine (ChildLinkField 'sample_orderid' IN-filter), summed, and coerced to
        /// Money on write.
        /// </summary>
        [Fact]
        public void CreateRecord_mathexpr_aggregate_over_child_node_writes_summed_value()
        {
            var ids = (
                rule: Guid.NewGuid(),
                rootCfg: Guid.NewGuid(),
                childCfg: Guid.NewGuid(),
                grp: Guid.NewGuid(),
                cond: Guid.NewGuid(),
                act: Guid.NewGuid()
            );
            var rootId = Guid.NewGuid();

            // Root TableConfig: sample_order
            var rootTableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.rootCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            // Child TableConfig: sample_orderline, linked back to the root via sample_orderid.
            // No condition references this node. It is seeded purely by the action's mathexpr.
            var childTableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.childCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.rootCfg),
                [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
            };
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ids.rule)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "sample_order",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
            };
            // Always-true condition on the root: name IsNotNull
            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
            };
            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), ids.cond)
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.rootCfg),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.IsNotNull),
            };
            // CreateRecord action: sum(node:<childCfg>.lineamount) into task.amount (Money)
            var action = new Entity(Q(SchemaNames.RuleAction.Entity), ids.act)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.CreateRecord),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                [Q(SchemaNames.RuleAction.TargetTable)] = "task",
                [Q(SchemaNames.RuleAction.FieldMapping)] =
                    "[{\"target\":\"amount\",\"source\":\"mathexpr\",\"expression\":\"sum(node:" + ids.childCfg + ".lineamount)\"}]",
                [Q(SchemaNames.RuleAction.IsActive)] = true,
                [Q(SchemaNames.RuleAction.Order)] = 1,
            };

            // Two orderline rows linked to the root via sample_orderid; summed lineamount = 40.
            var orderline1 = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["sample_orderid"] = new EntityReference("sample_order", rootId),
                ["lineamount"] = new Money(10m),
            };
            var orderline2 = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["sample_orderid"] = new EntityReference("sample_order", rootId),
                ["lineamount"] = new Money(30m),
            };

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                rootTableConfig, childTableConfig, rule, group, condition, action, orderline1, orderline2
            });

            var overlay = new Entity("sample_order", rootId) { ["name"] = "Order A" };

            var service = new ExtendedFakeService(
                ctx.GetOrganizationService(),
                metaByTable: new Dictionary<string, AttributeMetadata[]>
                {
                    ["task"] = new AttributeMetadata[] { new MoneyAttributeMetadata { LogicalName = "amount" } },
                });

            var outcome = new RulesEngineRunner().Run(
                systemService: service,
                userService: service,
                logicalName: "sample_order",
                inputs: new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                trigger: RuleTrigger.OnCreate,
                channel: RuleChannel.Standard,
                languageId: 1033,
                buildMode: RootBuildMode.UseTarget,
                trace: new XrmFakedTracingService());

            var fired = outcome.Records[0].FiredActions.Single(a => a.ActionType == ActionType.CreateRecord);
            Assert.NotNull(fired.WriteIntent);
            Assert.Equal("task", fired.WriteIntent.TargetTable);
            Assert.Equal(40m, ((Money)fired.WriteIntent.Values["amount"]).Value); // 10 + 30, coerced to Money
        }

        /// <summary>
        /// Expression-condition end-to-end: a rule on sample_order (OnCreate) has an EXECUTION
        /// condition group (IsExecutionCondition=true) whose single condition is a mathexpr
        /// Expression comparing sum(node:&lt;child&gt;.lineamount) &gt; 100. No action or other
        /// condition references the child node. It is seeded into the query plan/cache solely
        /// because the condition's own expression references it (the query planner's actionNodeIds loop).
        /// The seeded orderlines sum to 120, so the execution condition passes and the plain
        /// literal-mapping CreateRecord action fires OnMatch.
        /// </summary>
        [Fact]
        public void Expression_execution_condition_seeds_child_node_and_gates_action_firing()
        {
            var ids = (
                rule: Guid.NewGuid(),
                rootCfg: Guid.NewGuid(),
                childCfg: Guid.NewGuid(),
                grp: Guid.NewGuid(),
                cond: Guid.NewGuid(),
                act: Guid.NewGuid()
            );
            var rootId = Guid.NewGuid();

            // Root TableConfig: sample_order
            var rootTableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.rootCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            // Child TableConfig: sample_orderline, linked back to the root via sample_orderid.
            // No action or other condition references this node. It is seeded purely by the
            // execution condition's mathexpr.
            var childTableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.childCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.rootCfg),
                [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
            };
            var rule = new Entity(Q(SchemaNames.Rule.Entity), ids.rule)
            {
                [Q(SchemaNames.Rule.TableLogicalName)] = "sample_order",
                ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
            };
            // Execution condition group: sum(node:<child>.lineamount) > 100
            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = true,
            };
            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), ids.cond)
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.rootCfg),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.Expression),
                [Q(SchemaNames.RuleCondition.ConditionExpression)] = "sum(node:" + ids.childCfg + ".lineamount)",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.GreaterThan),
                [Q(SchemaNames.RuleCondition.ComparisonValue)] = "100",
            };
            // Plain literal-mapping CreateRecord action (OnMatch): does not itself reference
            // the child node in any way, proving the condition alone seeded it.
            var action = new Entity(Q(SchemaNames.RuleAction.Entity), ids.act)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.CreateRecord),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                [Q(SchemaNames.RuleAction.TargetTable)] = "task",
                [Q(SchemaNames.RuleAction.FieldMapping)] = "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Hello\"}]",
                [Q(SchemaNames.RuleAction.IsActive)] = true,
                [Q(SchemaNames.RuleAction.Order)] = 1,
            };

            // Two orderline rows linked to the root via sample_orderid; summed lineamount = 120 (> 100).
            var orderline1 = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["sample_orderid"] = new EntityReference("sample_order", rootId),
                ["lineamount"] = new Money(50m),
            };
            var orderline2 = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["sample_orderid"] = new EntityReference("sample_order", rootId),
                ["lineamount"] = new Money(70m),
            };

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity>
            {
                rootTableConfig, childTableConfig, rule, group, condition, action, orderline1, orderline2
            });

            var overlay = new Entity("sample_order", rootId) { ["name"] = "Order A" };

            var service = new ExtendedFakeService(
                ctx.GetOrganizationService(),
                metaByTable: new Dictionary<string, AttributeMetadata[]>
                {
                    ["task"] = new AttributeMetadata[] { new StringAttributeMetadata { LogicalName = "subject" } },
                });

            var outcome = new RulesEngineRunner().Run(
                systemService: service,
                userService: service,
                logicalName: "sample_order",
                inputs: new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                trigger: RuleTrigger.OnCreate,
                channel: RuleChannel.Standard,
                languageId: 1033,
                buildMode: RootBuildMode.UseTarget,
                trace: new XrmFakedTracingService());

            var fired = outcome.Records[0].FiredActions.SingleOrDefault(a => a.ActionType == ActionType.CreateRecord);
            Assert.NotNull(fired); // action fired -> execution condition (child-node aggregate) passed
            Assert.NotNull(fired.WriteIntent);
            Assert.Equal("task", fired.WriteIntent.TargetTable);
            Assert.Equal("Hello", fired.WriteIntent.Values["subject"]);
        }
    }
}
