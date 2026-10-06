using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin.Registration;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    // A published Create's asx_targetnode: a collection makes it Create per row; a single-record
    // target left by an earlier edit leaves it the one Create it always was, evaluated and
    // registered exactly as before.
    public partial class RuleRevisionTests
    {
        // A Create that fires when the rule's one outcome (Rule's group, rows[1]) is false; its tree rows follow it.
        private static List<Entity> CreateAction(List<Entity> rule, Guid? targetNode, string mapping)
        {
            var action = new Entity("asx_ruleaction", Guid.NewGuid())
            {
                ["asx_rule"] = new EntityReference("asx_rule", rule[0].Id),
                ["asx_actiontype"] = new OptionSetValue((int)ActionType.CreateRecord),
                ["asx_order"] = 2, ["asx_isactive"] = true, ["asx_targettable"] = "task",
                ["asx_targetnode"] = targetNode.HasValue ? new EntityReference("asx_tableconfig", targetNode.Value) : null,
                ["asx_fieldmapping"] = mapping,
            };
            var rows = new List<Entity> { action };
            rows.AddRange(ActionTreeRows.AnyFalse(action.Id, rule[1].Id));
            return rows;
        }

        // The write resolver coerces mapped values by the created table's column types.
        private static void TaskMetadata(TransactionalPluginContext context)
        {
            var task = new EntityMetadata { LogicalName = "task" };
            typeof(EntityMetadata).GetProperty("Attributes").SetValue(task, new AttributeMetadata[] { new StringAttributeMetadata { LogicalName = "subject" } });
            context.AddExecutionMock<RetrieveEntityRequest>(request => {
                var table = ((RetrieveEntityRequest)request).LogicalName;
                return new RetrieveEntityResponse { Results = new ParameterCollection { ["EntityMetadata"] = table == "task" ? task : new EntityMetadata { LogicalName = table } } };
            });
        }

        [Fact]
        public void A_published_create_with_a_stale_single_record_target_evaluates_and_registers_as_before()
        {
            var id = Guid.NewGuid(); var rows = Rule(id); var owner = Guid.NewGuid();
            rows.Add(new Entity("asx_tableconfig", owner) { ["asx_tablelogicalname"] = "systemuser", ["asx_tableconfigtype"] = new OptionSetValue(2),
                ["asx_parenttable"] = new EntityReference("asx_tableconfig", Model), ["asx_lookupcolumnlogicalname"] = "ownerid",
                ["asx_lookuptargetidattribute"] = "systemuserid" });
            rows.AddRange(CreateAction(rows, owner, "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Follow up\"}]"));
            var context = Context(rows); var service = context.GetOrganizationService();
            Freeze(service, id);
            TaskMetadata(context);

            var analysis = new TableRuleAnalyzer(service).Analyze("account", null).Single();
            Assert.True(analysis.IsRootOnly);

            var create = Run(service).Records.Single().FiredActions.Single(a => a.ActionType == ActionType.CreateRecord);
            Assert.False(create.IsSetAction);
            Assert.Equal("task", create.WriteIntent.TargetTable);
            Assert.Equal("Follow up", create.WriteIntent.Values["subject"]);
        }

        [Fact]
        public void A_published_create_per_row_creates_one_record_per_row_of_its_collection()
        {
            // Nothing but the Create names the contact node, so only the Create's target puts it in
            // the tree and the fetch.
            var id = Guid.NewGuid(); var rows = Rule(id); var contacts = Guid.NewGuid(); var account = Guid.NewGuid();
            rows.Add(new Entity("asx_tableconfig", contacts) { ["asx_tablelogicalname"] = "contact", ["asx_tableconfigtype"] = new OptionSetValue(3),
                ["asx_parenttable"] = new EntityReference("asx_tableconfig", Model), ["asx_childlinkfield"] = "parentcustomerid" });
            rows.AddRange(CreateAction(rows, contacts, "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Follow up\"}]"));
            foreach (var name in new[] { "Ann", "Bob" })
                rows.Add(new Entity("contact", Guid.NewGuid()) { ["fullname"] = name, ["parentcustomerid"] = new EntityReference("account", account) });
            var context = Context(rows); var service = context.GetOrganizationService();
            Freeze(service, id);
            TaskMetadata(context);

            Assert.False(new TableRuleAnalyzer(service).Analyze("account", null).Single().IsRootOnly);

            var outcome = new RulesEngineRunner().Run(service, service, "account",
                new List<RootInput> { new RootInput { Id = account, Overlay = new Entity("account", account) { ["name"] = "Invalid" } } },
                RuleTrigger.OnDemand, RuleChannel.Standard, 1033, RootBuildMode.UseTarget, new XrmFakedTracingService());
            var create = outcome.Records.Single().FiredActions.Single(a => a.ActionType == ActionType.CreateRecord);
            Assert.True(create.IsSetAction);
            Assert.Equal(2, create.WriteIntents.Count);
            Assert.All(create.WriteIntents, w => Assert.Equal("task", w.TargetTable));
        }
    }
}
