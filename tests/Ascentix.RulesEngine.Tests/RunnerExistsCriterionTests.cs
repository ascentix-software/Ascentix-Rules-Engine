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
    /// End-to-end: an EXISTS node-filter criterion loaded from real asx_nodefiltercriterion /
    /// asx_nodefiltergroup records (via RuleLoader + ConditionGroupMapper) drives the
    /// full RulesEngineRunner pipeline: the criterion's CollectionNodeId (a sibling collection
    /// no condition or action otherwise references) is seeded into the query plan so
    /// its records actually get queried and the sub-filter evaluated for real.
    ///
    /// Closes a follow-up left when that plan seeding landed: it could not be exercised end-to-end because
    /// ConditionGroupMapper could not yet produce an Exists criterion from records. It can now.
    ///
    /// Rule on sample_order (OnCreate): a RowCount condition (min 1) on the "line" child node,
    /// filtered by a self-owned NodeFilterGroup whose sole criterion is EXISTS on the sibling
    /// "shipment" collection (min 1, sub-filter statuscode eq expedited). If the collection
    /// node's config/data were not seeded, NodeRelate would throw (unknown node in `configs`)
    /// rather than silently pass, so a clean run proves the seeding actually happened; the
    /// positive/negative pair proves the seeded DATA (not just the config) drives the result.
    /// </summary>
    public class RunnerExistsCriterionTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // ── Fake service (metadata for "task", the CreateRecord action's target) ───

        private sealed class TaskMetadataFakeService : IOrganizationService
        {
            private readonly IOrganizationService _inner;
            public TaskMetadataFakeService(IOrganizationService inner) { _inner = inner; }

            public OrganizationResponse Execute(OrganizationRequest request)
            {
                if (request is RetrieveEntityRequest req && req.LogicalName == "task")
                {
                    var subjectAttr = new StringAttributeMetadata { LogicalName = "subject" };
                    var entityMeta = new EntityMetadata { LogicalName = "task" };
                    var attrsProp = typeof(EntityMetadata).GetProperty("Attributes");
                    attrsProp?.SetValue(entityMeta, new AttributeMetadata[] { subjectAttr });
                    return new RetrieveEntityResponse
                    {
                        Results = new ParameterCollection { { "EntityMetadata", entityMeta } }
                    };
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

        // ── Seed data ────────────────────────────────────────────────────────────

        private struct Ids
        {
            public Guid Rule, RootCfg, LineCfg, ShipmentCfg, Grp, Cond, FilterGroup, ExistsCriterion, SubFilterGroup, SubCriterion, Act;
        }

        /// <summary>
        /// Rule on sample_order (OnCreate): RowCount(line, min 1) filtered by an EXISTS
        /// criterion on the shipment collection (min 1, sub-filter statuscode eq expedited).
        /// CreateRecord (OnMatch) writes subject="Hello" to task.
        /// </summary>
        private static (List<Entity> seed, Ids ids) Seed()
        {
            var ids = new Ids
            {
                Rule = Guid.NewGuid(),
                RootCfg = Guid.NewGuid(),
                LineCfg = Guid.NewGuid(),
                ShipmentCfg = Guid.NewGuid(),
                Grp = Guid.NewGuid(),
                Cond = Guid.NewGuid(),
                FilterGroup = Guid.NewGuid(),
                ExistsCriterion = Guid.NewGuid(),
                SubFilterGroup = Guid.NewGuid(),
                SubCriterion = Guid.NewGuid(),
                Act = Guid.NewGuid(),
            };

            var seed = new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), ids.RootCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), ids.LineCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.RootCfg),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
                },
                // The EXISTS collection node, a sibling of "line", not referenced by any
                // condition's TableConfig or any action. Only the Exists criterion below
                // points at it; it must be seeded via the runner's Exists-criterion node walk.
                new Entity(Q(SchemaNames.TableConfig.Entity), ids.ShipmentCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_shipment",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.RootCfg),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_shipmentorderid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), ids.Rule)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "sample_order",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(
                        new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.Grp)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.Rule),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), ids.Cond)
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.Grp),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.LineCfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.RowCount),
                    [Q(SchemaNames.RuleCondition.MinExpectedRows)] = 1,
                },
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), ids.FilterGroup)
                {
                    [Q(SchemaNames.NodeFilterGroup.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.Grp),
                    [Q(SchemaNames.NodeFilterGroup.TableConfigNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.LineCfg),
                    [Q(SchemaNames.NodeFilterGroup.RuleCondition)] = new EntityReference(Q(SchemaNames.RuleCondition.Entity), ids.Cond),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                },
                new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), ids.ExistsCriterion)
                {
                    [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), ids.FilterGroup),
                    [Q(SchemaNames.NodeFilterCriterion.CriterionType)] = new OptionSetValue((int)CriterionKind.Exists),
                    [Q(SchemaNames.NodeFilterCriterion.CollectionNode)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.ShipmentCfg),
                    [Q(SchemaNames.NodeFilterCriterion.MinCount)] = 1,
                },
                // Sub-filter group owned by the criterion, NOT scoped to the condition group.
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), ids.SubFilterGroup)
                {
                    [Q(SchemaNames.NodeFilterGroup.OwningCriterion)] = new EntityReference(Q(SchemaNames.NodeFilterCriterion.Entity), ids.ExistsCriterion),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                },
                new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), ids.SubCriterion)
                {
                    [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), ids.SubFilterGroup),
                    [Q(SchemaNames.NodeFilterCriterion.FieldName)] = "statuscode",
                    [Q(SchemaNames.NodeFilterCriterion.Operator)] = "eq",
                    [Q(SchemaNames.NodeFilterCriterion.Value)] = "expedited",
                },
                new Entity(Q(SchemaNames.RuleAction.Entity), ids.Act)
                {
                    [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.Rule),
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.CreateRecord),
                    [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                    [Q(SchemaNames.RuleAction.TargetTable)] = "task",
                    [Q(SchemaNames.RuleAction.FieldMapping)] = "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Hello\"}]",
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                    [Q(SchemaNames.RuleAction.Order)] = 1,
                },
            };

            return (seed, ids);
        }

        private static RuleEvaluationOutcome Run(XrmFakedContext ctx, Guid rootId)
        {
            var service = new TaskMetadataFakeService(ctx.GetOrganizationService());
            var overlay = new Entity("sample_order", rootId) { ["name"] = "Order A" };
            return new RulesEngineRunner().Run(
                systemService: service,
                userService: service,
                logicalName: "sample_order",
                inputs: new List<RootInput> { new RootInput { Id = rootId, Overlay = overlay } },
                trigger: RuleTrigger.OnCreate,
                channel: RuleChannel.Standard,
                languageId: 1033,
                buildMode: RootBuildMode.UseTarget,
                trace: new XrmFakedTracingService());
        }

        [Fact]
        public void Exists_criterion_loaded_from_records_seeds_collection_and_matches_when_related_shipment_is_expedited()
        {
            var (seed, ids) = Seed();
            var rootId = Guid.NewGuid();

            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["sample_orderid"] = new EntityReference("sample_order", rootId),
            };
            var shipment = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["sample_shipmentorderid"] = new EntityReference("sample_order", rootId),
                ["statuscode"] = "expedited",
            };

            var ctx = new XrmFakedContext();
            ctx.Initialize(seed.Concat(new[] { line, shipment }).ToList());

            var outcome = Run(ctx, rootId);

            var fired = outcome.Records[0].FiredActions.SingleOrDefault(a => a.ActionType == ActionType.CreateRecord);
            Assert.NotNull(fired); // RowCount(line filtered by Exists) >= 1 -> matched -> action fired
            Assert.NotNull(fired.WriteIntent);
            Assert.Equal("Hello", fired.WriteIntent.Values["subject"]);
        }

        // ── Liveness: a persisted cycle in the sub-filter's own ParentFilterGroup chain ──
        // ── (group X's parent = Y, Y's parent = X) must not spin the BFS forever. ────────

        [Fact]
        public void Cyclic_sub_filter_parent_chain_throws_instead_of_looping_forever()
        {
            var (seed, ids) = Seed();
            var rootId = Guid.NewGuid();

            var line = new Entity("sample_orderline", Guid.NewGuid())
            {
                ["sample_orderid"] = new EntityReference("sample_order", rootId),
            };
            var shipment = new Entity("sample_shipment", Guid.NewGuid())
            {
                ["sample_shipmentorderid"] = new EntityReference("sample_order", rootId),
                ["statuscode"] = "expedited",
            };

            // A second sub-filter group Y, wired into a cycle with the root sub-filter
            // group X (ids.SubFilterGroup): Y's parent = X, and X's parent = Y.
            var cyclePartnerId = Guid.NewGuid();
            var cyclePartner = new Entity(Q(SchemaNames.NodeFilterGroup.Entity), cyclePartnerId)
            {
                [Q(SchemaNames.NodeFilterGroup.ParentFilterGroup)] = new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), ids.SubFilterGroup),
                [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
            };
            var rootSubFilterGroup = seed.Single(e => e.Id == ids.SubFilterGroup);
            rootSubFilterGroup[Q(SchemaNames.NodeFilterGroup.ParentFilterGroup)] =
                new EntityReference(Q(SchemaNames.NodeFilterGroup.Entity), cyclePartnerId);

            var ctx = new XrmFakedContext();
            ctx.Initialize(seed.Concat(new[] { line, shipment, cyclePartner }).ToList());

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => Run(ctx, rootId));
            Assert.Contains("cyclic", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
