using Ascentix.RulesEngine.Core.Execution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>Malformed <see cref="DateExprSpec.Parse"/> payloads. Only
    /// {"op":"add"} (missing 'anchor', covered in DateExprEvaluatorTests) was covered before
    /// this file; these are the seven other throws.</summary>
    public class DateExprSpecParseTests
    {
        [Theory]
        [InlineData(
            "{\"anchor\":{\"kind\":\"bogus\"},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}",
            "unknown anchor kind")]
        [InlineData(
            "{\"anchor\":{\"kind\":\"field\"},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}",
            "missing 'column'")]
        [InlineData(
            "{\"anchor\":{\"kind\":\"field\",\"column\":\"createdon\",\"node\":\"not-a-guid\"},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}",
            "not a valid GUID")]
        [InlineData(
            "{\"anchor\":{\"kind\":\"now\"},\"op\":\"multiply\",\"amount\":1,\"unit\":\"days\"}",
            "unknown op")]
        [InlineData(
            "{\"anchor\":{\"kind\":\"now\"},\"op\":\"add\",\"amount\":\"abc\",\"unit\":\"days\"}",
            "'amount' must be a positive whole number")]
        [InlineData(
            "{\"anchor\":{\"kind\":\"now\"},\"op\":\"add\",\"amount\":0,\"unit\":\"days\"}",
            "'amount' must be a positive whole number")]
        [InlineData(
            "{\"anchor\":{\"kind\":\"now\"},\"op\":\"add\",\"amount\":1,\"unit\":\"fortnights\"}",
            "unknown unit")]
        public void Malformed_payload_throws_with_expected_message(string json, string expectedMessageSubstring)
        {
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => DateExprSpec.Parse(json));
            Assert.Contains(expectedMessageSubstring, ex.Message);
        }

        [Fact]
        public void Not_json_throws_and_wraps_the_xml_exception()
        {
            var ex = Assert.Throws<InvalidPluginExecutionException>(() => DateExprSpec.Parse("{this is not json"));

            Assert.Contains("not valid JSON", ex.Message);
            Assert.IsType<System.Xml.XmlException>(ex.InnerException);
        }
    }
}
