using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public partial class RuleRevisionTests
    {
        // Two published rules, each with a RowCount (>= 1) on one contact child node of the
        // shared account root.
        private static (List<Entity> a, List<Entity> b, Guid account) TwoChildCountRules(Guid first, Guid second, Guid child)
        {
            var a = Rule(first, "A"); var b = Rule(second, "B");
            foreach (var rows in new[] { a, b })
            {
                rows[2]["asx_tableconfig"] = new EntityReference("asx_tableconfig", child);
                rows[2]["asx_conditiontype"] = new OptionSetValue(2); rows[2]["asx_minexpectedrows"] = 1;
            }
            a.Add(new Entity("asx_tableconfig", child) { ["asx_tablelogicalname"] = "contact", ["asx_tableconfigtype"] = new OptionSetValue(3),
                ["asx_parenttable"] = new EntityReference("asx_tableconfig", Model), ["asx_childlinkfield"] = "parentcustomerid" });
            var account = Guid.NewGuid();
            a.Add(new Entity("contact", Guid.NewGuid()) { ["parentcustomerid"] = new EntityReference("account", account) });
            return (a, b, account);
        }

        private static RuleEvaluationOutcome RunOn(IOrganizationService system, IOrganizationService user, Guid account) =>
            new RulesEngineRunner().Run(system, user, "account",
                new List<RootInput> { new RootInput { Id = account, Overlay = new Entity("account", account) } },
                RuleTrigger.OnDemand, RuleChannel.Standard, 1033, RootBuildMode.UseTarget, new XrmFakedTracingService());

        [Fact]
        public void Two_published_rules_on_one_child_fetch_it_once()
        {
            Guid first = Guid.NewGuid(), second = Guid.NewGuid(), child = Guid.NewGuid();
            var (a, b, account) = TwoChildCountRules(first, second, child);
            var service = Context(a, b).GetOrganizationService();
            Freeze(service, first); Freeze(service, second);
            var counting = new CountingOrganizationService(service);

            var outcome = RunOn(counting, counting, account);

            Assert.Equal(1, counting.Count("contact"));
            Assert.Equal(1, outcome.Diagnostics.FetchesShared);
            Assert.Equal(0, outcome.Diagnostics.FetchesWidened);
            Assert.Equal(1, outcome.Diagnostics.RetrieveMultipleCount);
        }

        [Fact]
        public void Two_published_rules_on_different_root_columns_read_the_root_once()
        {
            // A blocks unless name equals "Valid"; B blocks when telephone1 equals "555". Each
            // verdict needs its own column from the persisted row: the Target carries neither.
            Guid first = Guid.NewGuid(), second = Guid.NewGuid(), account = Guid.NewGuid();
            var a = Rule(first, "A"); var b = Rule(second, "B");
            b[2]["asx_comparisoncolumn"] = "telephone1";
            b[2]["asx_comparisonoperator"] = new OptionSetValue((int)ComparisonOperator.NotEquals);
            b[2]["asx_comparisonvalue"] = "555";
            a.Add(new Entity("account", account) { ["name"] = "Valid", ["telephone1"] = "555" });
            var context = Context(a, b);
            var service = context.GetOrganizationService();
            var metadata = ((RetrieveEntityResponse)service.Execute(new RetrieveEntityRequest { LogicalName = "account" })).EntityMetadata;
            typeof(EntityMetadata).GetProperty("Attributes").SetValue(metadata, new AttributeMetadata[]
                { new StringAttributeMetadata { LogicalName = "name" }, new StringAttributeMetadata { LogicalName = "telephone1" } });
            context.SetEntityMetadata(metadata);
            Freeze(service, first); Freeze(service, second);
            var counting = new CountingOrganizationService(service);

            var outcome = new RulesEngineRunner().Run(counting, counting, "account",
                new List<RootInput> { new RootInput { Id = account, Overlay = new Entity("account", account) } },
                RuleTrigger.OnUpdate, RuleChannel.Standard, 1033, RootBuildMode.RetrieveAndOverlay, new XrmFakedTracingService());

            Assert.Equal(1, counting.Count("account"));
            var columns = counting.Queries.Single(q => q.EntityName == "account").ColumnSet;
            Assert.False(columns.AllColumns);
            Assert.Contains("name", columns.Columns);
            Assert.Contains("telephone1", columns.Columns);
            Assert.Equal(2, outcome.Diagnostics.RulesEvaluated);
            var fired = Assert.Single(outcome.Records.Single().FiredActions);
            Assert.Equal(second, fired.RuleId);
            Assert.Equal(1, outcome.Diagnostics.FetchesShared);
            Assert.Equal(0, outcome.Diagnostics.FetchesWidened);
        }

        [Fact]
        public void User_and_system_context_rules_do_not_share_a_fetch()
        {
            Guid first = Guid.NewGuid(), second = Guid.NewGuid(), child = Guid.NewGuid();
            var (a, b, account) = TwoChildCountRules(first, second, child);
            b[0]["asx_evaluationcontext"] = new OptionSetValue((int)RuleEvaluationContext.System);
            var service = Context(a, b).GetOrganizationService();
            Freeze(service, first); Freeze(service, second);
            var system = new CountingOrganizationService(service);
            var user = new CountingOrganizationService(service);

            RunOn(system, user, account);

            Assert.Equal(1, user.Count("contact"));
            Assert.Equal(1, system.Count("contact"));
        }

        [Fact]
        public void Different_link_fields_on_one_node_are_fetched_separately()
        {
            Guid first = Guid.NewGuid(), second = Guid.NewGuid(), child = Guid.NewGuid();
            var (a, b, account) = TwoChildCountRules(first, second, child);
            var service = Context(a, b).GetOrganizationService();
            Freeze(service, first); Freeze(service, second);
            service.Update(new Entity("asx_tableconfig", child) { ["asx_childlinkfield"] = "alternateparentid" });
            Freeze(service, first, 2);
            var counting = new CountingOrganizationService(service);

            var outcome = RunOn(counting, counting, account);

            Assert.Equal(2, counting.Count("contact"));
            var fired = Assert.Single(outcome.Records.Single().FiredActions);
            Assert.Equal(first, fired.RuleId);
        }
    }
}
