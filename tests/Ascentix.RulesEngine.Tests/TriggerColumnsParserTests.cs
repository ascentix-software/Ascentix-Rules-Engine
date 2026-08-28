using Ascentix.RulesEngine.Core.Actions;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class TriggerColumnsParserTests
    {
        [Fact]
        public void Parses_json_array_of_column_names()
        {
            var cols = TriggerColumns.Parse("[\"sample_lineamount\",\"sample_quantity\"]");
            Assert.Equal(new[] { "sample_lineamount", "sample_quantity" }, cols.ToArray());
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("not json")]
        [InlineData("{\"a\":1}")] // an object, not an array of strings
        public void Blank_or_malformed_yields_empty(string json)
        {
            Assert.Empty(TriggerColumns.Parse(json));
        }
    }
}
