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
    /// <summary>The §1.1 shape on every enforcing path: an account rule that updates its active
    /// contacts (Rows filter statecode = 0) and creates a task per contact.</summary>
    public class SetActionPathTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);
        private static EntityReference Ref(string fragment, Guid id) => new EntityReference(Q(fragment), id);

        private readonly Guid _rule = Guid.NewGuid(), _rootCfg = Guid.NewGuid(), _contactsCfg = Guid.NewGuid();
        private readonly Guid _account = Guid.NewGuid(), _active = Guid.NewGuid(), _alreadyOptedOut = Guid.NewGuid(), _inactive = Guid.NewGuid();

        private List<Entity> Seed(RuleTrigger trigger, bool withCreatePerRow)
        {
            Guid group = Guid.NewGuid(), update = Guid.NewGuid(), filter = Guid.NewGuid();
            var rows = new List<Entity>
            {
                new Entity(Q(SchemaNames.TableConfig.Entity), _rootCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "account",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
                },
                new Entity(Q(SchemaNames.TableConfig.Entity), _contactsCfg)
                {
                    [Q(SchemaNames.TableConfig.TableLogicalName)] = "contact",
                    [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                    [Q(SchemaNames.TableConfig.ParentTable)] = Ref(SchemaNames.TableConfig.Entity, _rootCfg),
                    [Q(SchemaNames.TableConfig.ChildLinkField)] = "parentcustomerid",
                },
                new Entity(Q(SchemaNames.Rule.Entity), _rule)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Published),
                    [Q(SchemaNames.Rule.Triggers)] = new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue((int)trigger) }),
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
                    [Q(SchemaNames.RuleCondition.ComparisonColumn)] = "name",
                    [Q(SchemaNames.RuleCondition.ComparisonOperator)] = new OptionSetValue((int)ComparisonOperator.IsNotNull),
                },
                new Entity(Q(SchemaNames.RuleAction.Entity), update)
                {
                    [Q(SchemaNames.RuleAction.Rule)] = Ref(SchemaNames.Rule.Entity, _rule),
                    [Q(SchemaNames.PrimaryName)] = "Stop bulk email",
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.UpdateRecord),
                    [Q(SchemaNames.RuleAction.TargetNode)] = Ref(SchemaNames.TableConfig.Entity, _contactsCfg),
                    [Q(SchemaNames.RuleAction.FieldMapping)] = "[{\"target\":\"donotbulkemail\",\"source\":\"literal\",\"value\":true}]",
                    [Q(SchemaNames.RuleAction.Order)] = 1,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                },
                ActionTreeRows.AllTrue(update, group),
                new Entity(Q(SchemaNames.NodeFilterGroup.Entity), filter)
                {
                    [Q(SchemaNames.NodeFilterGroup.RuleAction)] = Ref(SchemaNames.RuleAction.Entity, update),
                    [Q(SchemaNames.NodeFilterGroup.TableConfigNode)] = Ref(SchemaNames.TableConfig.Entity, _contactsCfg),
                    [Q(SchemaNames.NodeFilterGroup.LogicalOperator)] = new OptionSetValue((int)CoreModels.LogicalOperator.And),
                },
                new Entity(Q(SchemaNames.NodeFilterCriterion.Entity), Guid.NewGuid())
                {
                    [Q(SchemaNames.NodeFilterCriterion.FilterGroup)] = Ref(SchemaNames.NodeFilterGroup.Entity, filter),
                    [Q(SchemaNames.NodeFilterCriterion.FieldName)] = "statecode",
                    [Q(SchemaNames.NodeFilterCriterion.Operator)] = "eq",
                    [Q(SchemaNames.NodeFilterCriterion.Value)] = "0",
                },
                new Entity("account", _account) { ["name"] = "Acme" },
                Contact(_active, "Ann", 0, false),
                Contact(_alreadyOptedOut, "Bob", 0, true),
                Contact(_inactive, "Cy", 1, false),
            };
            if (withCreatePerRow)
            {
                var create = Guid.NewGuid();
                rows.Add(new Entity(Q(SchemaNames.RuleAction.Entity), create)
                {
                    [Q(SchemaNames.RuleAction.Rule)] = Ref(SchemaNames.Rule.Entity, _rule),
                    [Q(SchemaNames.PrimaryName)] = "Follow up",
                    [Q(SchemaNames.RuleAction.ActionType)] = new OptionSetValue((int)ActionType.CreateRecord),
                    [Q(SchemaNames.RuleAction.TargetTable)] = "task",
                    [Q(SchemaNames.RuleAction.TargetNode)] = Ref(SchemaNames.TableConfig.Entity, _contactsCfg),
                    [Q(SchemaNames.RuleAction.FieldMapping)] =
                        "[{\"target\":\"regardingobjectid\",\"source\":\"row\",\"column\":\"contactid\"}," +
                        "{\"target\":\"subject\",\"source\":\"template\",\"template\":\"Follow up {row.fullname}\"}]",
                    [Q(SchemaNames.RuleAction.Order)] = 2,
                    [Q(SchemaNames.RuleAction.IsActive)] = true,
                });
                rows.AddRange(ActionTreeRows.AllTrue(create, group));
            }
            return rows;
        }

        private Entity Contact(Guid id, string name, int state, bool optedOut) => new Entity("contact", id)
        {
            ["fullname"] = name,
            ["parentcustomerid"] = new EntityReference("account", _account),
            ["statecode"] = new OptionSetValue(state),
            ["donotbulkemail"] = optedOut,
        };

        private static XrmFakedContext Context(List<Entity> seed)
        {
            var ctx = new XrmFakedContext();
            ctx.AddFakeMessageExecutor<RetrieveEntityRequest>(new FakeTablesMetadataExecutor(new Dictionary<string, AttributeMetadata[]>
            {
                ["contact"] = new AttributeMetadata[] { new BooleanAttributeMetadata { LogicalName = "donotbulkemail" }, new StringAttributeMetadata { LogicalName = "fullname" } },
                ["task"] = new AttributeMetadata[] { new StringAttributeMetadata { LogicalName = "subject" }, new LookupAttributeMetadata { LogicalName = "regardingobjectid" } },
                ["account"] = new AttributeMetadata[] { new StringAttributeMetadata { LogicalName = "name" } },
            }));
            ctx.Initialize(seed);
            return ctx;
        }

        private static bool OptedOut(IOrganizationService s, Guid id) =>
            s.Retrieve("contact", id, new ColumnSet("donotbulkemail")).GetAttributeValue<bool>("donotbulkemail");

        [Fact]
        public void A_form_save_updates_only_the_filtered_rows_and_creates_one_task_per_row()
        {
            var ctx = Context(Seed(RuleTrigger.OnUpdate, withCreatePerRow: true));
            ctx.ExecutePluginWith<RulesEnginePlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "Update", Stage = 20, Depth = 1,
                InputParameters = new ParameterCollection { { "Target", new Entity("account", _account) { ["name"] = "Acme" } } },
                SharedVariables = new ParameterCollection(),
            });

            var s = ctx.GetOrganizationService();
            Assert.True(OptedOut(s, _active));
            Assert.True(OptedOut(s, _alreadyOptedOut));
            Assert.False(OptedOut(s, _inactive)); // outside the Rows filter
            var tasks = s.RetrieveMultiple(new QueryExpression("task") { ColumnSet = new ColumnSet(true) }).Entities;
            Assert.Equal(3, tasks.Count);
            Assert.Contains(tasks, t => (string)t["subject"] == "Follow up Ann" && t.GetAttributeValue<EntityReference>("regardingobjectid").Id == _active);
        }

        [Fact]
        public void A_multi_record_save_builds_one_change_set_per_record()
        {
            var seed = Seed(RuleTrigger.OnUpdate, withCreatePerRow: false);
            var other = Guid.NewGuid(); var otherContact = Guid.NewGuid();
            seed.Add(new Entity("account", other) { ["name"] = "Beta" });
            seed.Add(new Entity("contact", otherContact) { ["fullname"] = "Di", ["parentcustomerid"] = new EntityReference("account", other),
                ["statecode"] = new OptionSetValue(0), ["donotbulkemail"] = false });
            var ctx = Context(seed);

            ctx.ExecutePluginWith<RulesEnginePlugin>(new XrmFakedPluginExecutionContext
            {
                MessageName = "UpdateMultiple", Stage = 20, Depth = 1,
                InputParameters = new ParameterCollection { { "Targets", new EntityCollection(new List<Entity>
                    { new Entity("account", _account) { ["name"] = "Acme" }, new Entity("account", other) { ["name"] = "Beta" } }) { EntityName = "account" } } },
                SharedVariables = new ParameterCollection(),
            });

            var s = ctx.GetOrganizationService();
            Assert.True(OptedOut(s, _active));
            Assert.True(OptedOut(s, otherContact));
        }

        [Fact]
        public void A_second_apply_writes_nothing()
        {
            var ctx = Context(Seed(RuleTrigger.OnDemand, withCreatePerRow: false));
            XrmFakedPluginExecutionContext Api() => new XrmFakedPluginExecutionContext
            {
                MessageName = SchemaNames.ApplyRulesApi.MessageName, Stage = 30,
                InputParameters = new ParameterCollection
                {
                    { SchemaNames.ApplyRulesApi.ParamRuleId, _rule.ToString() },
                    { SchemaNames.ApplyRulesApi.ParamRecordId, _account.ToString() },
                },
                OutputParameters = new ParameterCollection(),
            };

            var first = Api();
            ctx.ExecutePluginWith<ApplyRulesApi>(first);
            var second = Api();
            ctx.ExecutePluginWith<ApplyRulesApi>(second);

            Assert.Equal(1, (int)first.OutputParameters[SchemaNames.ApplyRulesApi.PropWriteCount]);  // Ann only
            Assert.Equal(0, (int)second.OutputParameters[SchemaNames.ApplyRulesApi.PropWriteCount]); // every row already there
        }

        [Fact]
        public void The_dry_run_reports_the_set_action_and_the_change_set_without_writing()
        {
            var ctx = Context(Seed(RuleTrigger.OnDemand, withCreatePerRow: true));
            var pctx = new XrmFakedPluginExecutionContext
            {
                MessageName = "asx_RunRules", Stage = 30,
                InputParameters = new ParameterCollection { { "TableName", "account" }, { "RecordId", _account.ToString() }, { "Triggers", "OnDemand" } },
                OutputParameters = new ParameterCollection(),
            };

            ctx.ExecutePluginWith<RunRulesApi>(pctx);

            var results = (string)pctx.OutputParameters["Results"];
            Assert.Contains("\"writeCount\":2", results);       // Ann and Bob pass the Rows filter
            Assert.Contains("\"unchangedCount\":1", results);   // Bob already opted out
            Assert.Equal("{\"creates\":3,\"updates\":1,\"deletes\":0,\"unchanged\":1}", (string)pctx.OutputParameters["ChangeSet"]);
            Assert.False(OptedOut(ctx.GetOrganizationService(), _active)); // nothing written
        }
    }
}
