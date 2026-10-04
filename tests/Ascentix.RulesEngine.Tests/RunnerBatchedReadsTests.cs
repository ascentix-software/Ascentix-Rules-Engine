using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public partial class RuleRevisionTests
    {
        [Fact]
        public void A_group_of_records_fetches_a_child_node_once_with_unchanged_verdicts()
        {
            Guid ruleId = Guid.NewGuid(), child = Guid.NewGuid();
            var rows = Rule(ruleId, "Needs a contact");
            rows[2]["asx_tableconfig"] = new EntityReference("asx_tableconfig", child);
            rows[2]["asx_conditiontype"] = new OptionSetValue(2); rows[2]["asx_minexpectedrows"] = 1;
            rows.Add(new Entity("asx_tableconfig", child) { ["asx_tablelogicalname"] = "contact", ["asx_tableconfigtype"] = new OptionSetValue(3),
                ["asx_parenttable"] = new EntityReference("asx_tableconfig", Model), ["asx_childlinkfield"] = "parentcustomerid" });
            var accounts = Enumerable.Range(0, 3).Select(_ => new Entity("account", Guid.NewGuid()) { ["name"] = "x" }).ToList();
            rows.AddRange(accounts);
            rows.Add(new Entity("contact", Guid.NewGuid()) { ["parentcustomerid"] = accounts[0].ToEntityReference() });
            rows.Add(new Entity("contact", Guid.NewGuid()) { ["parentcustomerid"] = accounts[2].ToEntityReference() });
            var service = Context(rows).GetOrganizationService();
            Freeze(service, ruleId);
            var counting = new CountingOrganizationService(service);

            var outcome = new RulesEngineRunner().Run(counting, counting, "account",
                accounts.Select(a => new RootInput { Id = a.Id }).ToList(),
                RuleTrigger.OnDemand, RuleChannel.Standard, 1033, RootBuildMode.RetrieveOnly, new XrmFakedTracingService());

            Assert.Equal(1, counting.Count("contact"));
            // Rule(...) fires its Block when the condition does NOT match: only the account without a contact.
            Assert.Equal(new[] { false, true, false }, outcome.Records.Select(r => r.HasBlock).ToArray());
        }

        [Fact]
        public void A_shared_rules_cache_loads_the_rules_once_and_keeps_the_counters()
        {
            var id = Guid.NewGuid(); var service = Context(Rule(id)).GetOrganizationService(); Freeze(service, id);
            var counting = new CountingOrganizationService(service);
            var cache = new LoadedRulesCache();
            RuleEvaluationOutcome Evaluate() => new RulesEngineRunner().Run(counting, counting, "account",
                new List<RootInput> { new RootInput { Overlay = new Entity("account", Guid.NewGuid()) { ["name"] = "Invalid" } } },
                RuleTrigger.OnDemand, RuleChannel.Standard, 1033, RootBuildMode.UseTarget, new XrmFakedTracingService(),
                rules: cache);

            var first = Evaluate();
            var reads = counting.Count("asx_rule");
            var second = Evaluate();

            Assert.Equal(reads, counting.Count("asx_rule"));
            Assert.Equal(first.Diagnostics.RulesLoaded, second.Diagnostics.RulesLoaded);
            Assert.Equal(first.Diagnostics.RulesEvaluated, second.Diagnostics.RulesEvaluated);
            Assert.DoesNotContain(second.Diagnostics.Stages, s => s.Name == "ruleLoad");
            Assert.Equal(first.Records.Single().FiredActions.Count, second.Records.Single().FiredActions.Count);
        }

        [Fact]
        public void Rules_are_cached_per_rule()
        {
            var a = Guid.NewGuid(); var b = Guid.NewGuid();
            var service = Context(Rule(a, "A"), Rule(b, "B")).GetOrganizationService(); Freeze(service, a); Freeze(service, b);
            var evaluator = new Ascentix.RulesEngine.Plugin.OnDemandEvaluator(service, service, 1033, new XrmFakedTracingService());
            var account = Guid.NewGuid();
            service.Create(new Entity("account", account) { ["name"] = "Invalid" });
            var ruleA = new OnDemandRule(a, "account", "A", OnDemandScope.GivenRecord, null, RuleEvaluationContext.User);
            var ruleB = new OnDemandRule(b, "account", "B", OnDemandScope.GivenRecord, null, RuleEvaluationContext.User);

            var outA = evaluator.Evaluate(ruleA, new[] { account });
            var outB = evaluator.Evaluate(ruleB, new[] { account });

            Assert.Equal(a, outA.Records.Single().FiredActions.Single().RuleId);
            Assert.Equal(b, outB.Records.Single().FiredActions.Single().RuleId);
        }
    }
}
