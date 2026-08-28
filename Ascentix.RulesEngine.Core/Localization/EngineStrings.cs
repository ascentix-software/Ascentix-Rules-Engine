using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Localization
{
    /// <summary>
    /// Localized engine framing strings (block header + no-message default), keyed by LCID.
    /// English (1033) is shipped; any unshipped language id falls back to English.
    /// Add entries to localize for more languages. Pure, therefore unit-testable.
    /// </summary>
    public static class EngineStrings
    {
        public const int DefaultLanguage = 1033;

        private static readonly Dictionary<int, string> Headers = new Dictionary<int, string>
        {
            { 1033, "This record could not be saved:" },
        };

        private static readonly Dictionary<int, string> Defaults = new Dictionary<int, string>
        {
            { 1033, "This record violates a validation rule and cannot be saved." },
        };

        public static string Header(int languageId) =>
            Headers.TryGetValue(languageId, out var s) ? s : Headers[DefaultLanguage];

        public static string DefaultBlockMessage(int languageId) =>
            Defaults.TryGetValue(languageId, out var s) ? s : Defaults[DefaultLanguage];
    }
}
