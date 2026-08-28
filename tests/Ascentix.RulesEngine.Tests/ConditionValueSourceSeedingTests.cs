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
    /// Regression pin: a condition whose RHS value-source is Template
    /// ({node:guid.col}) or DateExpression (field anchor on a node) references a related node ONLY
    /// inside its string payload. That node must still be seeded into the config load + query plan,
    /// or resolution throws "…not in the rule's config tree." Modeled on
    /// RunnerWriteIntentTests.UpdateRecord_on_lookup_node_not_referenced_by_condition_resolves_write_intent.
    /// </summary>
    public class ConditionValueSourceSeedingTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // A fake service that serves attribute metadata per table and pre-registered related records.
        private sealed class LookupFakeService : IOrganizationService
        {
            private readonly IOrganizationService _inner;
            private readonly Dictionary<string, AttributeMetadata[]> _metaByTable;

            public LookupFakeService(IOrganizationService inner, Dictionary<string, AttributeMetadata[]> metaByTable)
            {
                _inner = inner;
                _metaByTable = metaByTable;
            }

            public OrganizationResponse Execute(OrganizationRequest request)
            {
                if (request is RetrieveEntityRequest req && _metaByTable.TryGetValue(req.LogicalName, out var attrs))
                {
                    var entityMeta = new EntityMetadata { LogicalName = req.LogicalName };
                    var attrsProp = typeof(EntityMetadata).GetProperty("Attributes");
                    if (attrsProp != null) attrsProp.SetValue(entityMeta, attrs);
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

        // Root account + contact lookup (via primarycontactid) that NO structured field references.
        // The single condition (built by makeCondition) is the only thing referencing the contact node.
        private static (List<Entity> seed, Guid contactId, Entity overlay) Scenario(
            Entity condition, Entity rootWithLookup)
        {
            var ids = (rule: Guid.NewGuid(), rootCfg: Guid.NewGuid(), lookupCfg: Guid.NewGuid(),
                       grp: Guid.NewGuid(), act: Guid.NewGuid());
            var contactId = Guid.NewGuid();

            var rootTableConfig = new Entity(Q(SchemaNames.TableConfig.Entity), ids.rootCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
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
            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
            };
            condition[Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp);
            condition[Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.rootCfg);
            // Replace the placeholder lookup-cfg marker in the condition's payload with the real id.
            var payloadField = Q(SchemaNames.RuleCondition.ComparisonValue);
            if (condition.Contains(payloadField))
                condition[payloadField] = ((string)condition[payloadField]).Replace("LOOKUPCFG", ids.lookupCfg.ToString());

            // ShowMessage action (OnMatch): fires iff the condition matches, our observable.
            var action = new Entity(Q(SchemaNames.RuleAction.Entity), ids.act)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.ShowMessage),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                [Q(SchemaNames.RuleAction.Message)] = "matched",
                [Q(SchemaNames.RuleAction.IsActive)] = true,
                [Q(SchemaNames.RuleAction.Order)] = 1,
            };

            var contact = new Entity("contact", contactId) { ["lastname"] = "Smith", ["anchordate"] = new DateTime(2020, 6, 1) };
            rootWithLookup["primarycontactid"] = new EntityReference("contact", contactId);

            var seed = new List<Entity> { rootTableConfig, lookupTableConfig, rule, group, condition, action, contact };
            return (seed, contactId, rootWithLookup);
        }

        private static RuleEvaluationOutcome Run(List<Entity> seed, Entity overlay)
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);
            var service = new LookupFakeService(ctx.GetOrganizationService(),
                new Dictionary<string, AttributeMetadata[]>
                {
                    ["contact"] = new AttributeMetadata[]
                    {
                        new StringAttributeMetadata { LogicalName = "lastname" },
                        new DateTimeAttributeMetadata { LogicalName = "anchordate" },
                    },
                });
            return new RulesEngineRunner().Run(
                systemService: service, userService: service, logicalName: "account",
                inputs: new List<RootInput> { new RootInput { Id = overlay.Id, Overlay = overlay } },
                trigger: RuleTrigger.OnCreate, channel: RuleChannel.Standard, languageId: 1033,
                buildMode: RootBuildMode.UseTarget, trace: new XrmFakedTracingService());
        }

        [Fact]
        public void Condition_template_node_reference_is_seeded_and_resolves()
        {
            // name Equals "{node:<contact>.lastname}", with contact referenced ONLY by the template.
            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.Equals),
                [Q(SchemaNames.RuleCondition.ComparisonValueSource)] = new OptionSetValue((int)ComparisonValueSource.Template),
                [Q(SchemaNames.RuleCondition.ComparisonValue)] = "{node:LOOKUPCFG.lastname}",
            };
            var overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Smith" };
            var (seed, _, root) = Scenario(condition, overlay);

            var outcome = Run(seed, root);

            // Without the seeding this throws "…not in the rule's config tree". With it: contact
            // resolves, "Smith" Equals "Smith" → the OnMatch ShowMessage fires.
            Assert.Contains(outcome.Records[0].FiredActions, a => a.ActionType == ActionType.ShowMessage);
        }

        [Fact]
        public void Condition_dateexpr_field_anchor_node_is_seeded_and_resolves()
        {
            // mydate <= {field anchor: contact.anchordate + 1 day}. contact referenced ONLY by the anchor.
            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), Guid.NewGuid())
            {
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "mydate",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.LessThanOrEqual),
                [Q(SchemaNames.RuleCondition.ComparisonValueSource)] = new OptionSetValue((int)ComparisonValueSource.DateExpression),
                [Q(SchemaNames.RuleCondition.ComparisonValue)] =
                    "{\"anchor\":{\"kind\":\"field\",\"node\":\"LOOKUPCFG\",\"column\":\"anchordate\"},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}",
            };
            var overlay = new Entity("account", Guid.NewGuid()) { ["mydate"] = new DateTime(2020, 1, 1) };
            var (seed, _, root) = Scenario(condition, overlay);

            var outcome = Run(seed, root);

            // Without the seeding this throws. With it: anchor resolves to 2020-06-02; 2020-01-01 <= that → match.
            Assert.Contains(outcome.Records[0].FiredActions, a => a.ActionType == ActionType.ShowMessage);
        }

        [Fact]
        public void NodeReferences_returns_distinct_node_guids_excluding_root_and_escapes()
        {
            var g1 = Guid.NewGuid();
            var g2 = Guid.NewGuid();
            var template = "Order {root.name} — {node:" + g1 + ".a} / {node:" + g2 + ".b} / {node:" + g1 + ".c} {{lit}}";

            var refs = TemplateRenderer.NodeReferences(template).ToList();

            Assert.Equal(2, refs.Count);          // g1 appears twice → distinct
            Assert.Contains(g1, refs);
            Assert.Contains(g2, refs);
            Assert.Empty(TemplateRenderer.NodeReferences(null));
            Assert.Empty(TemplateRenderer.NodeReferences("only {root.x} and literal"));
        }
    }
}
