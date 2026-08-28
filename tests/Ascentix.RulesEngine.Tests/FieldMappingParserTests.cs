using System;
using System.Linq;
using Ascentix.RulesEngine.Core.Actions;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class FieldMappingParserTests
    {
        [Fact]
        public void Empty_or_null_returns_empty_list()
        {
            Assert.Empty(FieldMappingParser.Parse(null));
            Assert.Empty(FieldMappingParser.Parse("  "));
        }

        [Fact]
        public void Parses_literal_root_and_node_sources()
        {
            var node = Guid.NewGuid();
            var json =
                "[" +
                "{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Hi\"}," +
                "{\"target\":\"statuscode\",\"source\":\"literal\",\"value\":2}," +
                "{\"target\":\"regardingid\",\"source\":\"root\",\"column\":\"accountid\"}," +
                "{\"target\":\"ownerid\",\"source\":\"node\",\"node\":\"" + node + "\",\"column\":\"manager\"}" +
                "]";

            var entries = FieldMappingParser.Parse(json);

            Assert.Equal(4, entries.Count);
            Assert.Equal("subject", entries[0].Target);
            Assert.Equal("literal", entries[0].Source);
            Assert.Equal("Hi", entries[0].Value);
            Assert.Equal(2, entries[1].Value);                 // integral → int
            Assert.Equal("root", entries[2].Source);
            Assert.Equal("accountid", entries[2].Column);
            Assert.Equal("node", entries[3].Source);
            Assert.Equal(node, entries[3].Node);
            Assert.Equal("manager", entries[3].Column);
        }

        [Fact]
        public void Lookup_literal_decodes_to_entity_reference()
        {
            var id = Guid.NewGuid();
            var json = "[{\"target\":\"ownerid\",\"source\":\"literal\",\"value\":" +
                       "{\"id\":\"" + id + "\",\"logicalname\":\"systemuser\"}}]";

            var entry = FieldMappingParser.Parse(json).Single();
            var er = Assert.IsType<EntityReference>(entry.Value);
            Assert.Equal(id, er.Id);
            Assert.Equal("systemuser", er.LogicalName);
        }

        [Fact]
        public void Malformed_json_throws()
        {
            Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse("not json"));
        }

        [Fact]
        public void Unknown_source_throws()
        {
            var json = "[{\"target\":\"x\",\"source\":\"bogus\"}]";
            Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
        }

        [Fact]
        public void Parses_template_entry()
        {
            var json = "[{\"target\":\"subject\",\"source\":\"template\",\"template\":\"Hi {root.name}\"}]";
            var e = FieldMappingParser.Parse(json)[0];
            Assert.Equal("template", e.Source);
            Assert.Equal("Hi {root.name}", e.Template);
        }

        [Fact]
        public void Template_without_text_throws()
        {
            var json = "[{\"target\":\"subject\",\"source\":\"template\"}]";
            Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
        }

        [Fact]
        public void Parses_dateexpr_with_now_anchor()
        {
            var json = "[{\"target\":\"followupby\",\"source\":\"dateexpr\"," +
                "\"anchor\":{\"kind\":\"now\"},\"op\":\"add\",\"amount\":3,\"unit\":\"days\"}]";
            var e = FieldMappingParser.Parse(json)[0];
            Assert.Equal("dateexpr", e.Source);
            Assert.Equal("now", e.AnchorKind);
            Assert.Null(e.AnchorNode);
            Assert.Equal("add", e.Op);
            Assert.Equal(3, e.Amount);
            Assert.Equal("days", e.Unit);
        }

        [Fact]
        public void Parses_dateexpr_with_field_anchor_on_node()
        {
            var node = Guid.NewGuid();
            var json = "[{\"target\":\"followupby\",\"source\":\"dateexpr\"," +
                $"\"anchor\":{{\"kind\":\"field\",\"node\":\"{node}\",\"column\":\"createdon\"}}," +
                "\"op\":\"subtract\",\"amount\":2,\"unit\":\"weeks\"}]";
            var e = FieldMappingParser.Parse(json)[0];
            Assert.Equal("field", e.AnchorKind);
            Assert.Equal(node, e.AnchorNode);
            Assert.Equal("createdon", e.AnchorColumn);
            Assert.Equal("subtract", e.Op);
        }

        [Fact]
        public void Dateexpr_field_anchor_with_null_node_means_root()
        {
            var json = "[{\"target\":\"followupby\",\"source\":\"dateexpr\"," +
                "\"anchor\":{\"kind\":\"field\",\"node\":null,\"column\":\"createdon\"}," +
                "\"op\":\"add\",\"amount\":1,\"unit\":\"months\"}]";
            var e = FieldMappingParser.Parse(json)[0];
            Assert.Equal("field", e.AnchorKind);
            Assert.Null(e.AnchorNode);
            Assert.Equal("createdon", e.AnchorColumn);
        }

        [Theory]
        [InlineData("{\"kind\":\"tomorrow\"}", "\"op\":\"add\",\"amount\":1,\"unit\":\"days\"")]   // bad anchor kind
        [InlineData("{\"kind\":\"field\"}", "\"op\":\"add\",\"amount\":1,\"unit\":\"days\"")]      // field anchor missing column
        [InlineData("{\"kind\":\"now\"}", "\"op\":\"multiply\",\"amount\":1,\"unit\":\"days\"")]   // bad op
        [InlineData("{\"kind\":\"now\"}", "\"op\":\"add\",\"amount\":0,\"unit\":\"days\"")]        // non-positive amount
        [InlineData("{\"kind\":\"now\"}", "\"op\":\"add\",\"amount\":1,\"unit\":\"decades\"")]     // bad unit
        public void Invalid_dateexpr_shapes_throw(string anchor, string rest)
        {
            var json = "[{\"target\":\"followupby\",\"source\":\"dateexpr\",\"anchor\":" + anchor + "," + rest + "}]";
            Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
        }

        [Fact]
        public void Dateexpr_missing_anchor_throws()
        {
            var json = "[{\"target\":\"followupby\",\"source\":\"dateexpr\",\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}]";
            Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
        }

        [Fact]
        public void Parses_ref_source_with_node()
        {
            var node = Guid.NewGuid();
            var json = "[{\"target\":\"objectid\",\"source\":\"ref\",\"node\":\"" + node + "\"}]";
            var e = FieldMappingParser.Parse(json).Single();
            Assert.Equal("ref", e.Source);
            Assert.Equal("objectid", e.Target);
            Assert.Equal(node, e.Node);
        }

        [Fact]
        public void Ref_source_with_bad_node_throws()
        {
            var json = "[{\"target\":\"objectid\",\"source\":\"ref\",\"node\":\"not-a-guid\"}]";
            Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
        }

        [Fact]
        public void Parses_mathexpr_entry()
        {
            var json = "[{\"target\":\"sample_lineamount\",\"source\":\"mathexpr\"," +
                       "\"expression\":\"{root.sample_quantity} * 2\"}]";
            var entries = FieldMappingParser.Parse(json);
            Assert.Single(entries);
            Assert.Equal("mathexpr", entries[0].Source);
            Assert.Equal("{root.sample_quantity} * 2", entries[0].Expression);
        }

        [Fact]
        public void Mathexpr_missing_expression_throws()
        {
            var json = "[{\"target\":\"x\",\"source\":\"mathexpr\"}]";
            Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
        }

        [Fact]
        public void Mathexpr_malformed_expression_throws()
        {
            var json = "[{\"target\":\"x\",\"source\":\"mathexpr\",\"expression\":\"1 +\"}]";
            Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
        }
    }
}
