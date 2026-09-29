using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Xunit;
using CoreModels = Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>A CreateMultiple whose Targets carry no ids (every in-flight record is Guid.Empty),
    /// as the engine's own CreateMultiple sends them: each record keeps its own in-flight Target.</summary>
    public class CreateMultipleWithoutIdsTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);
        private static EntityReference Ref(string fragment, Guid id) => new EntityReference(Q(fragment), id);

        private readonly Guid _rule = Guid.NewGuid(), _rootCfg = Guid.NewGuid();

        // An OnCreate rule on <paramref name="table"/>: "<paramref name="nameColumn"/> is not null"
        // fires one Update Record action onto <paramref name="targetCfg"/> with <paramref name="mapping"/>.
        private List<Entity> Rule(string table, string nameColumn, Guid targetCfg, string mapping)
        {
            var group = Guid.NewGuid();
            return new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), _rootCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = table,
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.Rule.Entity), _rule)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = table,
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
                },
                new Entity(Q(SchemaNames.ConditionGroup.Entity), group)
                {
                    [Q(SchemaNames.ConditionGroup.Rule)] = Ref(SchemaNames.Rule.Entity, _rule),
                    [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                    [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
                },
                new Entity(Q(SchemaNames.RuleCondition.Entity), Guid.NewGuid())
                {
                    [Q(SchemaNames.RuleCondition.ConditionGroup)] = Ref(SchemaNames.ConditionGroup.Entity, group),
                    [Q(SchemaNames.RuleCondition.TableConfig)] = Ref(SchemaNames.TableConfig.Entity, _rootCfg),
                    [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = nameColumn,
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.IsNotNull),
                },
                new Entity(Q(SchemaNames.RuleAction.Entity), Guid.NewGuid())
                {
                    [Q(SchemaNames.RuleAction.Rule)] = Ref(SchemaNames.Rule.Entity, _rule),
                    [Q(SchemaNames.PrimaryName)] = "Stamp",
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.UpdateRecord),
                    [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                    [Q(SchemaNames.RuleAction.TargetNode)] = Ref(SchemaNames.TableConfig.Entity, targetCfg),
                    [Q(SchemaNames.RuleAction.FieldMapping)] = mapping,
                    [Q(SchemaNames.RuleAction.Order)] = 1,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                },
            };
        }

        private static XrmFakedContext Context(List<Entity> seed, string table, params string[] stringColumns)
        {
            var ctx = new XrmFakedContext();
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new FakeTablesMetadataExecutor(new Dictionary<string, AttributeMetadata[]>
            {
                [table] = stringColumns.Select(c => (AttributeMetadata)new StringAttributeMetadata { LogicalName = c }).ToArray(),
            }));
            ctx.Initialize(seed);
            return ctx;
        }

        private static void CreateMultiple(XrmFakedContext ctx, string table, params Entity[] targets) =>
            ctx.ExecutePluginWith<RulesEnginePlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "CreateMultiple", Stage = 20, Depth = 1,
                InputParameters = new ParameterCollection { { "Targets", new EntityCollection(targets.ToList()) { EntityName = table } } },
                SharedVariables = new ParameterCollection(),
            });

        [Fact]
        public void A_create_multiple_without_ids_writes_each_record_in_place_onto_its_own_target()
        {
            // The engine's own CreateMultiple (a Create per row) sends no ids; a task rule with a
            // server action then runs on it. Pairing the records with their Targets by id would
            // collide on Guid.Empty and fail the save.
            var ctx = Context(Rule("task", "subject", _rootCfg, "[{\"target\":\"description\",\"source\":\"root\",\"column\":\"subject\"}]"),
                "task", "subject", "description");
            var first = new Entity("task") { ["subject"] = "First" };
            var second = new Entity("task") { ["subject"] = "Second" };

            CreateMultiple(ctx, "task", first, second);

            Assert.Equal("First", first["description"]);
            Assert.Equal("Second", second["description"]);
        }

        [Fact]
        public void A_set_update_over_siblings_being_created_writes_only_the_evaluated_row_in_place()
        {
            // Line-rooted: every line of the line's order (sample_description := the row's name).
            // Two lines are created together with no ids; the reconciler adds both into each line's
            // sibling collection. Each line's change set must take only ITS row as the record being
            // saved: the other in-flight line has no id to write to and gets its own evaluation.
            Guid orderCfg = Guid.NewGuid(), siblingsCfg = Guid.NewGuid(), order = Guid.NewGuid(), persisted = Guid.NewGuid();
            var seed = Rule("sample_orderline", "sample_name", siblingsCfg,
                "[{\"target\":\"sample_description\",\"source\":\"row\",\"column\":\"sample_name\"}]");
            seed.Add(new Entity(Q(SchemaNames.TableConfig.Entity), orderCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                [Q(SchemaNames.TableConfig.ParentTable)] = Ref(SchemaNames.TableConfig.Entity, _rootCfg),
                [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "sample_orderid",
                [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "sample_orderid",
            });
            seed.Add(new Entity(Q(SchemaNames.TableConfig.Entity), siblingsCfg)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                [Q(SchemaNames.TableConfig.ParentTable)] = Ref(SchemaNames.TableConfig.Entity, orderCfg),
                [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
            });
            seed.Add(new Entity("sample_order", order) { ["sample_orderid"] = order, ["sample_name"] = "Order" });
            seed.Add(new Entity("sample_orderline", persisted)
            {
                ["sample_orderlineid"] = persisted, ["sample_name"] = "Persisted", ["sample_orderid"] = new EntityReference("sample_order", order),
            });
            var ctx = Context(seed, "sample_orderline", "sample_name", "sample_description");
            var first = new Entity("sample_orderline") { ["sample_name"] = "First", ["sample_orderid"] = new EntityReference("sample_order", order) };
            var second = new Entity("sample_orderline") { ["sample_name"] = "Second", ["sample_orderid"] = new EntityReference("sample_order", order) };

            CreateMultiple(ctx, "sample_orderline", first, second);

            Assert.Equal("First", first["sample_description"]);
            Assert.Equal("Second", second["sample_description"]);
            var saved = ctx.GetOrganizationService().Retrieve("sample_orderline", persisted, new ColumnSet("sample_description"));
            Assert.Equal("Persisted", saved["sample_description"]); // the persisted sibling is still written by request
        }
    }
}
