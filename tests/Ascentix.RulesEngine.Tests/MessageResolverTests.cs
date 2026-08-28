using Ascentix.RulesEngine.Core.Localization;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class MessageResolverTests
    {
        private static RuleAction Action(string message, params (int lang, string text)[] localized)
        {
            var a = new RuleAction { Message = message };
            foreach (var (lang, text) in localized) a.LocalizedMessages[lang] = text;
            return a;
        }

        [Fact]
        public void Returns_localized_when_present()
            => Assert.Equal("Nom invalide.",
                MessageResolver.Resolve(Action("Invalid name.", (1036, "Nom invalide.")), 1036));

        [Fact]
        public void Falls_back_to_default_message_when_language_missing()
            => Assert.Equal("Invalid name.",
                MessageResolver.Resolve(Action("Invalid name.", (1036, "Nom invalide.")), 1033));

        [Fact]
        public void Falls_back_to_engine_default_when_no_message_at_all()
            => Assert.Equal(EngineStrings.DefaultBlockMessage(1033),
                MessageResolver.Resolve(Action(null), 1033));

        [Fact]
        public void Blank_localized_value_is_treated_as_missing()
            => Assert.Equal("Invalid name.",
                MessageResolver.Resolve(Action("Invalid name.", (1036, "   ")), 1036));
    }
}
