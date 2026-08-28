using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using FakeXrmEasy.FakeMessageExecutors;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Xunit;
using CoreModels = Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Integration tests: RulesEnginePlugin wires WriteActionExecutor.
    /// Scenario: Published account rule (OnCreate), always-true validation group,
    /// one CreateRecord action (target=task, subject=literal "Hi").
    /// External trigger (no engine 'tag', any depth) → task is created; an engine-initiated
    /// re-entry (the loop 'tag' present) → no task.
    /// </summary>
    public class RulesEnginePluginWriteTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // ── Fake message executor: answers RetrieveEntityRequest for "task" ─────

        /// <summary>
        /// Implements IFakeMessageExecutor so XrmFakedContext intercepts
        /// RetrieveEntityRequest for "task" and returns attribute metadata
        /// (subject → String), enabling literal coercion inside the runner.
        /// </summary>
        private sealed class TaskMetadataExecutor : IFakeMessageExecutor
        {
            public bool CanExecute(OrganizationRequest request)
                => request is RetrieveEntityRequest req && req.LogicalName == "task";

            public Type GetResponsibleRequestType() => typeof(RetrieveEntityRequest);

            public OrganizationResponse Execute(OrganizationRequest request, XrmFakedContext ctx)
            {
                var subjectAttr = new StringAttributeMetadata { LogicalName = "subject" };
                var entityMeta = new EntityMetadata { LogicalName = "task" };

                // Inject Attributes via reflection (setters are sealed in the SDK).
                var attrsProp = typeof(EntityMetadata).GetProperty("Attributes");
                if (attrsProp != null)
                    attrsProp.SetValue(entityMeta, new AttributeMetadata[] { subjectAttr });
                else
                {
                    var field = typeof(EntityMetadata).GetField("_attributes",
                        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                    field?.SetValue(entityMeta, new AttributeMetadata[] { subjectAttr });
                }

                return new RetrieveEntityResponse
                {
                    Results = new ParameterCollection { { "EntityMetadata", entityMeta } }
                };
            }
        }

        // ── Seed data ────────────────────────────────────────────────────────────

        /// <summary>
        /// Rule on account (OnCreate), always-true condition (name IsNotNull),
        /// one CreateRecord action (OnMatch): writes subject="Hi" to task table.
        /// </summary>
        private static List<Entity> Seed()
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
                    new List<OptionSetValue> { new OptionSetValue((int)RuleTrigger.OnCreate) }),
            };

            // Always-true condition group (name IsNotNull; the target will have name set).
            var group = new Entity(Q(SchemaNames.ConditionGroup.Entity), ids.grp)
            {
                [Q(SchemaNames.ConditionGroup.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.ConditionGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                [Q(SchemaNames.ConditionGroup.IsExecutionCondition)] = false,
            };

            var condition = new Entity(Q(SchemaNames.RuleCondition.Entity), ids.cond)
            {
                [Q(SchemaNames.RuleCondition.ConditionGroup)] = new EntityReference(Q(SchemaNames.ConditionGroup.Entity), ids.grp),
                [Q(SchemaNames.RuleCondition.TableConfig)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), ids.cfg),
                [Q(SchemaNames.RuleCondition.ConditionType)] = new OptionSetValue((int)ConditionType.FieldComparison),
                [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.IsNotNull),
            };

            // CreateRecord action: target=task, mapping subject=literal "Hi".
            var action = new Entity(Q(SchemaNames.RuleAction.Entity), ids.act)
            {
                [Q(SchemaNames.RuleAction.Rule)] = new EntityReference(Q(SchemaNames.Rule.Entity), ids.rule),
                [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.CreateRecord),
                [Q(SchemaNames.RuleAction.FireOn)] = new OptionSetValue((int)ActionFireOn.OnMatch),
                [Q(SchemaNames.RuleAction.TargetTable)] = "task",
                [Q(SchemaNames.RuleAction.FieldMapping)] = "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Hi\"}]",
                [Q(SchemaNames.RuleAction.IsActive)] = true,
                [Q(SchemaNames.RuleAction.Order)] = 1,
            };

            return new List<Entity> { tableConfig, rule, group, condition, action };
        }

        private static XrmFakedPluginExecutionContext PluginCtx(Entity target, int depth = 1, string tag = null)
        {
            var shared = new ParameterCollection();
            if (tag != null) shared["tag"] = tag;
            return new XrmFakedPluginExecutionContext
            {
                MessageName = "Create",
                Stage = 20,
                Depth = depth,
                InputParameters = new ParameterCollection { { "Target", target } },
                SharedVariables = shared,
            };
        }

        // ── Tests ────────────────────────────────────────────────────────────────

        [Fact]
        public void CreateRecord_action_fires_and_task_is_created_at_depth_1()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new TaskMetadataExecutor());

            var target = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme Corp" };

            // Should not throw (no block action in this rule).
            ctx.ExecutePluginWith<RulesEnginePlugin>(PluginCtx(target, depth: 1));

            // The WriteActionExecutor called IOrganizationService.Create("task", ...).
            // XrmFakedContext stores created entities in its Data dictionary.
            var tasks = ctx.GetOrganizationService()
                .RetrieveMultiple(new QueryExpression("task") { ColumnSet = new ColumnSet(true) });

            Assert.Single(tasks.Entities);
            Assert.Equal("Hi", tasks.Entities[0]["subject"]);
        }

        [Fact]
        public void CreateRecord_action_fires_for_external_trigger_at_depth_2()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new TaskMetadataExecutor());

            var target = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme Corp" };

            // Depth 2 but no engine 'tag': a legitimate external trigger (e.g. another
            // plugin's update). Writes must apply.
            ctx.ExecutePluginWith<RulesEnginePlugin>(PluginCtx(target, depth: 2));

            var tasks = ctx.GetOrganizationService()
                .RetrieveMultiple(new QueryExpression("task") { ColumnSet = new ColumnSet(true) });

            Assert.Single(tasks.Entities);
            Assert.Equal("Hi", tasks.Entities[0]["subject"]);
        }

        [Fact]
        public void CreateRecord_action_is_skipped_when_engine_initiated()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(Seed());
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new TaskMetadataExecutor());

            var target = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme Corp" };

            // The engine's own write carries the loop 'tag', a re-entry we must not cascade.
            ctx.ExecutePluginWith<RulesEnginePlugin>(
                PluginCtx(target, depth: 2, tag: PluginReentry.EngineWriteTag));

            var tasks = ctx.GetOrganizationService()
                .RetrieveMultiple(new QueryExpression("task") { ColumnSet = new ColumnSet(true) });

            Assert.Empty(tasks.Entities);
        }
    }
}
