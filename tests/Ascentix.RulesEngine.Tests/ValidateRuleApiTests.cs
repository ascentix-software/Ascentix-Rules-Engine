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
    public class ValidateRuleApiTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        private static XrmFakedPluginExecutionContext ApiContext(ParameterCollection input)
            => new XrmFakedPluginExecutionContext
            {
                MessageName = "asx_ValidateRule",
                Stage = 30,
                IsInTransaction = true,
                InputParameters = input,
                OutputParameters = new ParameterCollection()
            };

        [Fact]
        public void Empty_draft_rule_reports_invalid_with_issues()
        {
            var ruleId = Guid.NewGuid();
            var ctx = new TransactionalPluginContext();
            ctx.Initialize(new List<Entity>
            {
                new Entity(PublicationSchema.Lock, PublicationSchema.LockId),
                new Entity(Q(SchemaNames.Rule.Entity), ruleId)
                {
                    [Q(SchemaNames.Rule.TableLogicalName)] = "account",
                    ["statuscode"] = new OptionSetValue((int)RuleStatus.Draft),
                }
            });

            var pctx = ApiContext(new ParameterCollection { { "RuleId", ruleId.ToString() } });
            ctx.ExecuteTransactional<ValidateRuleApi>(pctx);

            Assert.False((bool)pctx.OutputParameters["IsValid"]);
            Assert.Contains("STRUCT_NO_CONDITIONS", (string)pctx.OutputParameters["Issues"]);
        }

        [Fact]
        public void Missing_rule_id_throws()
        {
            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { new Entity(PublicationSchema.Lock, PublicationSchema.LockId) });
            Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecutePluginWith<ValidateRuleApi>(ApiContext(new ParameterCollection())));
        }

        [Fact]
        public void Unknown_rule_throws()
        {
            var ctx = new TransactionalPluginContext();
            var missingId = Guid.NewGuid();
            ctx.Initialize(new List<Entity> { new Entity(PublicationSchema.Lock, PublicationSchema.LockId), new Entity("asx_rule", Guid.NewGuid()) });
            var error = Assert.Throws<InvalidPluginExecutionException>(() =>
                ctx.ExecuteTransactional<ValidateRuleApi>(ApiContext(new ParameterCollection { { "RuleId", missingId.ToString() } })));
            Assert.Contains(missingId.ToString(), error.Message);
        }
    }
}
