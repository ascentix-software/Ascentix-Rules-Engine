using Ascentix.RulesEngine.Core.Localization;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class EngineStringsTests
    {
        [Fact]
        public void English_header_and_default_for_1033()
        {
            Assert.Equal("This record could not be saved:", EngineStrings.Header(1033));
            Assert.Equal("This record violates a validation rule and cannot be saved.",
                EngineStrings.DefaultBlockMessage(1033));
        }

        [Fact]
        public void Unshipped_language_falls_back_to_english()
        {
            Assert.Equal(EngineStrings.Header(1033), EngineStrings.Header(1036));
            Assert.Equal(EngineStrings.DefaultBlockMessage(1033), EngineStrings.DefaultBlockMessage(3084));
        }
    }
}
