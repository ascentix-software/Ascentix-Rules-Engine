using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;
using Ascentix.RulesEngine.Core.Publication;

namespace Ascentix.RulesEngine.Tests
{
    public class RulePublishPluginTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        // An invalid rule = exists but has no conditions/actions.
        private static Entity SeedInvalidRule(Guid ruleId) => new Entity(Q(SchemaNames.Rule.Entity), ruleId)
        {
            [Q(SchemaNames.Rule.TableLogicalName)] = "account",
            ["statuscode"] = new OptionSetValue((int)RuleStatus.Draft),
        };

        private static XrmFakedPluginExecutionContext UpdateContext(Entity target, OptionSetValue preStatus)
        {
            var preImage = new Entity(Q(SchemaNames.Rule.Entity), target.Id) { ["statuscode"] = preStatus };
            return new XrmFakedPluginExecutionContext
            {
                MessageName = "Update",
                Stage = 20, // pre-operation
                PrimaryEntityName = Q(SchemaNames.Rule.Entity),
                InputParameters = new ParameterCollection { { "Target", target } },
                PreEntityImages = new EntityImageCollection { { "PreImage", preImage } },
            };
        }

        [Fact]
        public void Draft_to_published_invalid_rule_throws()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { SeedInvalidRule(ruleId), new Entity(PublicationSchema.Lock, PublicationSchema.LockId) });

            var target = new Entity(Q(SchemaNames.Rule.Entity), ruleId) { ["statuscode"] = new OptionSetValue((int)RuleStatus.Published) };
            var pctx = UpdateContext(target, new OptionSetValue((int)RuleStatus.Draft));

            Assert.Throws<InvalidPluginExecutionException>(() => ctx.ExecutePluginWith<RulePublishPlugin>(pctx));
        }

        [Fact]
        public void Draft_save_of_invalid_rule_does_not_throw()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { SeedInvalidRule(ruleId) });

            // statuscode not in Target → not a publish transition
            var target = new Entity(Q(SchemaNames.Rule.Entity), ruleId) { [Q(SchemaNames.Rule.TableLogicalName)] = "account" };
            var pctx = UpdateContext(target, new OptionSetValue((int)RuleStatus.Draft));

            ctx.ExecutePluginWith<RulePublishPlugin>(pctx); // no throw
        }

        [Fact]
        public void Already_published_status_write_validates_a_new_revision()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { SeedInvalidRule(ruleId), new Entity(PublicationSchema.Lock, PublicationSchema.LockId) });

            var target = new Entity(Q(SchemaNames.Rule.Entity), ruleId) { ["statuscode"] = new OptionSetValue((int)RuleStatus.Published) };
            var pctx = UpdateContext(target, new OptionSetValue((int)RuleStatus.Published)); // old already Published

            Assert.Throws<InvalidPluginExecutionException>(() => ctx.ExecutePluginWith<RulePublishPlugin>(pctx));
        }

        [Fact]
        public void Publish_with_absent_preimage_still_gates_invalid_rule()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { SeedInvalidRule(ruleId), new Entity(PublicationSchema.Lock, PublicationSchema.LockId) });

            var target = new Entity(Q(SchemaNames.Rule.Entity), ruleId) { ["statuscode"] = new OptionSetValue((int)RuleStatus.Published) };
            var pctx = new XrmFakedPluginExecutionContext
            {
                MessageName = "Update",
                Stage = 20, // pre-operation
                PrimaryEntityName = Q(SchemaNames.Rule.Entity),
                InputParameters = new ParameterCollection { { "Target", target } },
                PreEntityImages = new EntityImageCollection(), // Empty: absent PreImage
            };

            Assert.Throws<InvalidPluginExecutionException>(() => ctx.ExecutePluginWith<RulePublishPlugin>(pctx));
        }
    }
}
