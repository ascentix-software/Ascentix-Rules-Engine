using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class LocalizationModelTests
    {
        [Fact]
        public void RuleAction_has_empty_localized_messages_by_default()
        {
            var a = new RuleAction();
            Assert.NotNull(a.LocalizedMessages);
            Assert.Empty(a.LocalizedMessages);
        }

        [Fact]
        public void SchemaNames_qualify_localizedmessage()
        {
            Assert.Equal("asx_localizedmessage", SchemaNames.Qualify(SchemaNames.LocalizedMessage.Entity));
            Assert.Equal("asx_languagecode", SchemaNames.Qualify(SchemaNames.LocalizedMessage.LanguageCode));
            Assert.Equal("asx_message", SchemaNames.Qualify(SchemaNames.LocalizedMessage.Message));
            Assert.Equal("asx_ruleaction", SchemaNames.Qualify(SchemaNames.LocalizedMessage.RuleAction));
        }
    }
}
