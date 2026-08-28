using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Ascentix.RulesEngine.Core.Validation;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleValidatorTests
    {
        private class EmptyFlags : IAttributeFlagsProvider
        {
            public bool TableExists(string table) => true;
            public AttributeFlags GetFlags(string table, string column) => new AttributeFlags { IsValidForCreate = true, IsValidForUpdate = true, IsValidForRead = true, Type = Microsoft.Xrm.Sdk.Metadata.AttributeTypeCode.String };
        }

        [Fact]
        public void Empty_rule_is_invalid_with_structural_errors()
        {
            var model = new RuleForValidation
            {
                RuleId = Guid.NewGuid(),
                PrimaryTable = "account",
                Groups = new List<ConditionGroup>(),
                Configs = TableConfigTree.Empty,
                Actions = new List<RuleAction>(),
            };
            var report = RuleValidator.Validate(model, new EmptyFlags());
            Assert.False(report.IsValid);
            Assert.Contains(report.Issues, i => i.Code == "STRUCT_NO_CONDITIONS");
            Assert.Contains(report.Issues, i => i.Code == "STRUCT_NO_ACTIONS");
        }
    }
}
