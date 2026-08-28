using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class OptionLabelExtractionTests
    {
        private static Label L(string text)
        {
            var locLabel = new LocalizedLabel(text, 1033);
            var label = new Label(locLabel, new LocalizedLabel[0]);
            label.UserLocalizedLabel = locLabel;
            return label;
        }

        [Fact]
        public void Extracts_picklist_and_boolean_labels()
        {
            // Constructors set SchemaName only, so LogicalName must be set explicitly for the test.
            var pick = new PicklistAttributeMetadata("statuscode")
            {
                LogicalName = "statuscode",
                OptionSet = new OptionSetMetadata { Options = { new OptionMetadata(L("Open"), 1), new OptionMetadata(L("Closed"), 2) } }
            };
            var flag = new BooleanAttributeMetadata("isescalated")
            {
                LogicalName = "isescalated",
                OptionSet = new BooleanOptionSetMetadata(new OptionMetadata(L("Yes"), 1), new OptionMetadata(L("No"), 0))
            };
            var str = new StringAttributeMetadata("subject") { LogicalName = "subject" };

            var map = AttributeMetadataProvider.ExtractOptionLabels(
                new List<AttributeMetadata> { pick, flag, str });

            Assert.Equal("Open", map["statuscode"][1]);
            Assert.Equal("Closed", map["statuscode"][2]);
            Assert.Equal("Yes", map["isescalated"][1]);
            Assert.Equal("No", map["isescalated"][0]);
            Assert.False(map.ContainsKey("subject"));
        }
    }
}
