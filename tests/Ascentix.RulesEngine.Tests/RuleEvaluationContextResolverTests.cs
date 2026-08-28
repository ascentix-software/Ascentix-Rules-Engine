using System;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleEvaluationContextResolverTests
    {
        private static Entity Rule() => new Entity(SchemaNames.Qualify(SchemaNames.Rule.Entity), Guid.NewGuid());
        private static string Field => SchemaNames.Qualify(SchemaNames.Rule.EvaluationContext);

        [Fact]
        public void Defaults_to_user_when_attribute_absent()
        {
            Assert.Equal(RuleEvaluationContext.User, RuleEvaluationContextResolver.Resolve(Rule()));
        }

        [Fact]
        public void Defaults_to_user_when_attribute_null()
        {
            var rule = Rule();
            rule[Field] = null;
            Assert.Equal(RuleEvaluationContext.User, RuleEvaluationContextResolver.Resolve(rule));
        }

        [Fact]
        public void Reads_system_when_set()
        {
            var rule = Rule();
            rule[Field] = new OptionSetValue((int)RuleEvaluationContext.System);
            Assert.Equal(RuleEvaluationContext.System, RuleEvaluationContextResolver.Resolve(rule));
        }

        [Fact]
        public void Reads_user_when_set()
        {
            var rule = Rule();
            rule[Field] = new OptionSetValue((int)RuleEvaluationContext.User);
            Assert.Equal(RuleEvaluationContext.User, RuleEvaluationContextResolver.Resolve(rule));
        }
    }
}
