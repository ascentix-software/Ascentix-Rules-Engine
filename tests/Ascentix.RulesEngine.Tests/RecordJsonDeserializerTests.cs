using System;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RecordJsonDeserializerTests
    {
        [Fact]
        public void Empty_or_null_json_yields_empty_entity_of_logical_name()
        {
            var e = RecordJsonDeserializer.Deserialize("account", null);
            Assert.Equal("account", e.LogicalName);
            Assert.Empty(e.Attributes);

            var e2 = RecordJsonDeserializer.Deserialize("account", "   ");
            Assert.Empty(e2.Attributes);
        }

        [Fact]
        public void Decodes_string_bool_and_integer()
        {
            var e = RecordJsonDeserializer.Deserialize("account",
                "{\"name\":\"Acme\",\"donotemail\":true,\"numberofemployees\":50}");

            Assert.Equal("Acme", e["name"]);
            Assert.Equal(true, e["donotemail"]);
            Assert.Equal(50, e["numberofemployees"]);
        }

        [Fact]
        public void Decodes_fractional_number_as_decimal()
        {
            var e = RecordJsonDeserializer.Deserialize("account", "{\"revenue\":123.45}");
            Assert.Equal(123.45m, e["revenue"]);
        }

        [Fact]
        public void Decodes_lookup_object_as_entity_reference()
        {
            var id = Guid.NewGuid();
            var e = RecordJsonDeserializer.Deserialize("account",
                "{\"primarycontactid\":{\"id\":\"" + id + "\",\"logicalname\":\"contact\"}}");

            var er = Assert.IsType<EntityReference>(e["primarycontactid"]);
            Assert.Equal(id, er.Id);
            Assert.Equal("contact", er.LogicalName);
        }

        [Fact]
        public void Decodes_integer_array_as_multiselect_optionset()
        {
            var e = RecordJsonDeserializer.Deserialize("account", "{\"asx_categories\":[1,2,3]}");

            var coll = Assert.IsType<OptionSetValueCollection>(e["asx_categories"]);
            Assert.Equal(new[] { 1, 2, 3 }, coll.Select(o => o.Value).ToArray());
        }

        [Fact]
        public void Decodes_null_as_null_attribute()
        {
            var e = RecordJsonDeserializer.Deserialize("account", "{\"name\":null}");
            Assert.True(e.Contains("name"));
            Assert.Null(e["name"]);
        }

        [Fact]
        public void Malformed_json_throws_invalid_plugin_execution()
        {
            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => RecordJsonDeserializer.Deserialize("account", "{\"name\":}"));
            Assert.Contains("RecordJson", ex.Message);
        }
    }
}
