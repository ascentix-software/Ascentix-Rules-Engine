using System;
using System.Linq;
using Ascentix.RulesEngine.Core.Publication;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Plugin.Publication;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleSetTests
    {
        private static void Update(TransactionalPluginContext context, Entity patch) =>
            context.ExecuteTransactional<RuleRevisionGuardPlugin>(new XrmFakedPluginExecutionContext { Stage = 20, MessageName = "Update",
                PrimaryEntityName = patch.LogicalName, InputParameters = new ParameterCollection { { "Target", patch } } });

        [Fact]
        public void Setting_the_rule_set_on_a_published_rule_needs_no_working_draft()
        {
            var id = Guid.NewGuid(); var context = RuleRevisionTests.Context(RuleRevisionTests.Rule(id)); var service = context.GetOrganizationService();
            Update(context, new Entity("asx_rule", id) { [PublicationSchema.RuleSet] = new EntityReference(PublicationSchema.RuleSet, Guid.NewGuid()) });
            Assert.Null(RuleDrafts.Find(service, id));
        }

        [Fact]
        public void Snapshots_and_hashes_ignore_the_rule_set()
        {
            var id = Guid.NewGuid(); var context = RuleRevisionTests.Context(RuleRevisionTests.Rule(id)); var service = context.GetOrganizationService();
            var before = RuleSnapshot.Capture(service, id).Hash();
            service.Update(new Entity("asx_rule", id) { [PublicationSchema.RuleSet] = new EntityReference(PublicationSchema.RuleSet, Guid.NewGuid()) });
            var snapshot = RuleSnapshot.Capture(service, id);
            Assert.Equal(before, snapshot.Hash());
            Assert.DoesNotContain(snapshot.Rows, row => row.Attributes.ContainsKey(PublicationSchema.RuleSet));
        }

        [Fact]
        public void Changing_another_header_field_with_the_rule_set_still_needs_a_draft()
        {
            var id = Guid.NewGuid(); var context = RuleRevisionTests.Context(RuleRevisionTests.Rule(id));
            var error = Assert.Throws<InvalidPluginExecutionException>(() => Update(context, new Entity("asx_rule", id) {
                [PublicationSchema.RuleSet] = new EntityReference(PublicationSchema.RuleSet, Guid.NewGuid()), ["asx_name"] = "Renamed" }));
            Assert.Equal("Edit this rule's working draft in the Rule Builder.", error.Message);
        }
    }
}
