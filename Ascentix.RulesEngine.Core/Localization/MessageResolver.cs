using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Localization
{
    /// <summary>
    /// Resolves the message string for a rule action in a target language.
    /// Order: localized text for the language → the action's default Message →
    /// the engine's localized default. Pure, therefore unit-testable.
    /// </summary>
    public static class MessageResolver
    {
        public static string Resolve(RuleAction action, int languageId)
        {
            if (action?.LocalizedMessages != null
                && action.LocalizedMessages.TryGetValue(languageId, out var loc)
                && !string.IsNullOrWhiteSpace(loc))
                return loc;

            if (!string.IsNullOrWhiteSpace(action?.Message))
                return action.Message;

            return EngineStrings.DefaultBlockMessage(languageId);
        }
    }
}
