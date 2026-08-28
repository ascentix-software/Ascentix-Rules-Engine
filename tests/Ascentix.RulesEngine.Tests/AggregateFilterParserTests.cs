using System;
using System.Linq;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Covers two things: the mathexpr field-mapping entry's "filters" JSON map, deserialized by
    /// <see cref="AggregateFilterParser"/> into <see cref="FieldMappingEntry.Filters"/>
    /// (Dictionary&lt;string, NodeFilterGroup&gt;), and the filter-key integrity check wired into
    /// <see cref="FieldMappingParser"/>.
    /// </summary>
    public class AggregateFilterParserTests
    {
        private static string MappingJson(Guid childNode, Guid refNode, string expression = null)
        {
            expression = expression ?? $"sum(node:{childNode}.amount filter:f1)";
            return
                "[{" +
                "\"target\":\"sample_ordertotal\"," +
                "\"source\":\"mathexpr\"," +
                "\"expression\":\"" + expression.Replace("\\", "\\\\") + "\"," +
                "\"filters\":{" +
                "  \"f1\":{" +
                "    \"kind\":\"group\",\"id\":\"g1\",\"op\":\"and\"," +
                "    \"rules\":[" +
                "      {\"kind\":\"rule\",\"id\":\"r1\",\"column\":\"statuscode\",\"operator\":1,\"valueSource\":1,\"value\":\"1\",\"valueNodeId\":null,\"valueColumn\":null}," +
                "      {\"kind\":\"rule\",\"id\":\"r2\",\"column\":\"amount\",\"operator\":3,\"valueSource\":2,\"value\":null,\"valueNodeId\":\"" + refNode + "\",\"valueColumn\":\"threshold\"}," +
                "      {\"kind\":\"group\",\"id\":\"g2\",\"op\":\"or\",\"rules\":[" +
                "        {\"kind\":\"rule\",\"id\":\"r3\",\"column\":\"priority\",\"operator\":2,\"valueSource\":1,\"value\":\"5\",\"valueNodeId\":null,\"valueColumn\":null}" +
                "      ]}" +
                "    ]" +
                "  }" +
                "}" +
                "}]";
        }

        /// <summary>Wraps a raw filter-group JSON body (the value of the "f1" key) in a full
        /// mathexpr field-mapping entry so it round-trips through <see cref="FieldMappingParser"/>
        /// (and, internally, <see cref="AggregateFilterParser"/>) the same way production input does.</summary>
        private static string MappingJsonWithFilterBody(Guid childNode, string filterBodyJson)
        {
            var expression = $"sum(node:{childNode}.amount filter:f1)";
            return
                "[{" +
                "\"target\":\"sample_ordertotal\"," +
                "\"source\":\"mathexpr\"," +
                "\"expression\":\"" + expression + "\"," +
                "\"filters\":{" +
                "  \"f1\":" + filterBodyJson +
                "}" +
                "}]";
        }

        [Theory]
        [InlineData(1, "eq")]
        [InlineData(2, "ne")]
        [InlineData(3, "gt")]
        [InlineData(4, "ge")]
        [InlineData(5, "lt")]
        [InlineData(6, "le")]
        [InlineData(7, "contains")]
        [InlineData(8, "not-contains")]
        [InlineData(9, "null")]
        [InlineData(10, "not-null")]
        public void TokenFor_maps_operator_code_to_expected_token(int code, string expectedToken)
        {
            var childNode = Guid.NewGuid();
            var filterBody =
                "{\"op\":\"and\",\"rules\":[" +
                "  {\"kind\":\"rule\",\"column\":\"statuscode\",\"operator\":" + code + ",\"valueSource\":1,\"value\":\"1\"}" +
                "]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var entry = FieldMappingParser.Parse(json).Single();

            Assert.Equal(expectedToken, entry.Filters["f1"].Criteria[0].Operator);
        }

        [Fact]
        public void Unknown_operator_code_throws()
        {
            var childNode = Guid.NewGuid();
            var filterBody =
                "{\"op\":\"and\",\"rules\":[" +
                "  {\"kind\":\"rule\",\"column\":\"statuscode\",\"operator\":99,\"valueSource\":1,\"value\":\"1\"}" +
                "]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("unknown operator 99", ex.Message);
        }

        [Fact]
        public void Unknown_group_op_throws()
        {
            var childNode = Guid.NewGuid();
            var filterBody = "{\"op\":\"xor\",\"rules\":[]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("unknown op 'xor'", ex.Message);
        }

        [Fact]
        public void Absent_group_op_throws_naming_the_empty_string()
        {
            var childNode = Guid.NewGuid();
            // ChildValue returns null when 'op' is omitted entirely; the message interpolates
            // that null into an empty string, not the literal text "null".
            var filterBody = "{\"rules\":[]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("unknown op ''", ex.Message);
        }

        [Fact]
        public void Unknown_rule_kind_throws()
        {
            var childNode = Guid.NewGuid();
            var filterBody = "{\"op\":\"and\",\"rules\":[{\"kind\":\"widget\"}]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("unknown kind 'widget'", ex.Message);
        }

        [Fact]
        public void Leaf_missing_column_throws()
        {
            var childNode = Guid.NewGuid();
            var filterBody = "{\"op\":\"and\",\"rules\":[{\"kind\":\"rule\",\"operator\":1}]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("missing 'column'", ex.Message);
        }

        [Fact]
        public void Leaf_missing_operator_throws()
        {
            var childNode = Guid.NewGuid();
            var filterBody = "{\"op\":\"and\",\"rules\":[{\"kind\":\"rule\",\"column\":\"statuscode\"}]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("missing or invalid 'operator'", ex.Message);
        }

        [Fact]
        public void Leaf_invalid_valueSource_throws()
        {
            var childNode = Guid.NewGuid();
            var filterBody =
                "{\"op\":\"and\",\"rules\":[" +
                "  {\"kind\":\"rule\",\"column\":\"statuscode\",\"operator\":1,\"valueSource\":\"abc\"}" +
                "]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("invalid 'valueSource'", ex.Message);
        }

        [Fact]
        public void Leaf_invalid_valueNodeId_throws()
        {
            var childNode = Guid.NewGuid();
            var filterBody =
                "{\"op\":\"and\",\"rules\":[" +
                "  {\"kind\":\"rule\",\"column\":\"statuscode\",\"operator\":1,\"valueNodeId\":\"not-a-guid\"}" +
                "]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("invalid 'valueNodeId'", ex.Message);
        }

        [Fact]
        public void Exists_missing_collectionNodeId_throws()
        {
            var childNode = Guid.NewGuid();
            var filterBody =
                "{\"op\":\"and\",\"rules\":[" +
                "  {\"kind\":\"exists\",\"sub\":{\"op\":\"and\",\"rules\":[]}}" +
                "]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("missing or invalid 'collectionNodeId'", ex.Message);
        }

        [Fact]
        public void Exists_missing_sub_throws()
        {
            var childNode = Guid.NewGuid();
            var collectionNode = Guid.NewGuid();
            var filterBody =
                "{\"op\":\"and\",\"rules\":[" +
                "  {\"kind\":\"exists\",\"collectionNodeId\":\"" + collectionNode + "\"}" +
                "]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("missing 'sub'", ex.Message);
        }

        [Fact]
        public void Exists_invalid_minCount_throws()
        {
            var childNode = Guid.NewGuid();
            var collectionNode = Guid.NewGuid();
            var filterBody =
                "{\"op\":\"and\",\"rules\":[" +
                "  {\"kind\":\"exists\",\"collectionNodeId\":\"" + collectionNode + "\",\"minCount\":\"abc\"}" +
                "]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var ex = Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
            Assert.Contains("invalid 'minCount'", ex.Message);
        }

        [Fact]
        public void Value_source_outside_the_enum_range_is_cast_unchecked_and_treated_as_literal()
        {
            // Characterization: "7" parses, is cast unchecked to (ComparisonValueSource)7, and
            // ResolveRhs treats any non-FieldReference as Literal. Pinned, not endorsed.
            var childNode = Guid.NewGuid();
            var filterBody =
                "{\"op\":\"and\",\"rules\":[" +
                "  {\"kind\":\"rule\",\"column\":\"statuscode\",\"operator\":1,\"valueSource\":7,\"value\":\"1\"}" +
                "]}";
            var json = MappingJsonWithFilterBody(childNode, filterBody);

            var entry = FieldMappingParser.Parse(json).Single();

            var leaf = entry.Filters["f1"].Criteria[0];
            Assert.Equal((ComparisonValueSource)7, leaf.ValueSource);
            Assert.NotEqual(ComparisonValueSource.FieldReference, leaf.ValueSource);
        }

        [Fact]
        public void Parses_filters_map_with_nested_group_and_field_reference_leaf()
        {
            var childNode = Guid.NewGuid();
            var refNode = Guid.NewGuid();
            var json = MappingJson(childNode, refNode);

            var entry = FieldMappingParser.Parse(json).Single();

            Assert.NotNull(entry.Filters);
            Assert.True(entry.Filters.ContainsKey("f1"));
            var group = entry.Filters["f1"];

            Assert.Equal(LogicalOperator.And, group.LogicalOperator);
            Assert.Equal(2, group.Criteria.Count);

            var literalLeaf = group.Criteria[0];
            Assert.Equal("statuscode", literalLeaf.FieldName);
            Assert.Equal("eq", literalLeaf.Operator);
            Assert.Equal("1", literalLeaf.Value);
            Assert.Equal(ComparisonValueSource.Literal, literalLeaf.ValueSource);
            Assert.Null(literalLeaf.ComparisonValueNodeId);
            Assert.Null(literalLeaf.ComparisonValueColumn);

            var fieldRefLeaf = group.Criteria[1];
            Assert.Equal("amount", fieldRefLeaf.FieldName);
            Assert.Equal("gt", fieldRefLeaf.Operator);
            Assert.Equal(ComparisonValueSource.FieldReference, fieldRefLeaf.ValueSource);
            Assert.Equal(refNode, fieldRefLeaf.ComparisonValueNodeId);
            Assert.Equal("threshold", fieldRefLeaf.ComparisonValueColumn);

            Assert.Single(group.ChildGroups);
            var nested = group.ChildGroups[0];
            Assert.Equal(LogicalOperator.Or, nested.LogicalOperator);
            Assert.Single(nested.Criteria);
            Assert.Equal("priority", nested.Criteria[0].FieldName);
            Assert.Equal("ne", nested.Criteria[0].Operator);
            Assert.Equal("5", nested.Criteria[0].Value);
        }

        [Fact]
        public void Mathexpr_without_filters_key_yields_empty_map()
        {
            var childNode = Guid.NewGuid();
            var json = "[{\"target\":\"t\",\"source\":\"mathexpr\",\"expression\":\"sum(node:" + childNode + ".amount)\"}]";

            var entry = FieldMappingParser.Parse(json).Single();

            Assert.NotNull(entry.Filters);
            Assert.Empty(entry.Filters);
        }

        [Fact]
        public void Filter_key_referenced_by_expression_but_missing_from_filters_throws()
        {
            var childNode = Guid.NewGuid();
            var json = "[{\"target\":\"t\",\"source\":\"mathexpr\"," +
                       "\"expression\":\"sum(node:" + childNode + ".amount filter:f1)\"}]";

            Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
        }

        [Fact]
        public void Orphaned_filters_entry_not_referenced_by_expression_throws()
        {
            var childNode = Guid.NewGuid();
            var refNode = Guid.NewGuid();
            // f1 is defined in filters, but the expression doesn't reference filter:f1.
            var json = MappingJson(childNode, refNode, $"sum(node:{childNode}.amount)");

            Assert.Throws<InvalidPluginExecutionException>(() => FieldMappingParser.Parse(json));
        }

        [Fact]
        public void Parses_exists_criterion_with_subfilter()
        {
            var childNode = Guid.NewGuid();
            var collectionNode = Guid.NewGuid();
            var expression = $"sum(node:{childNode}.amount filter:f1)";
            var json =
                "[{" +
                "\"target\":\"sample_ordertotal\"," +
                "\"source\":\"mathexpr\"," +
                "\"expression\":\"" + expression + "\"," +
                "\"filters\":{" +
                "  \"f1\":{" +
                "    \"kind\":\"group\",\"id\":\"g1\",\"op\":\"and\"," +
                "    \"rules\":[" +
                "      {\"kind\":\"exists\",\"id\":\"e1\",\"collectionNodeId\":\"" + collectionNode + "\"," +
                "       \"minCount\":1,\"maxCount\":null," +
                "       \"sub\":{\"op\":\"and\",\"rules\":[" +
                "         {\"kind\":\"rule\",\"id\":\"r1\",\"column\":\"statuscode\",\"operator\":1,\"valueSource\":1,\"value\":\"1\",\"valueNodeId\":null,\"valueColumn\":null}" +
                "       ]}}" +
                "    ]" +
                "  }" +
                "}" +
                "}]";

            var entry = FieldMappingParser.Parse(json).Single();

            var group = entry.Filters["f1"];
            Assert.Single(group.Criteria);
            var existsCriterion = group.Criteria[0];

            Assert.Equal(CriterionKind.Exists, existsCriterion.Kind);
            Assert.Equal(collectionNode, existsCriterion.CollectionNodeId);
            Assert.Equal(1, existsCriterion.MinCount);
            Assert.Null(existsCriterion.MaxCount);

            Assert.NotNull(existsCriterion.SubFilter);
            Assert.Equal(LogicalOperator.And, existsCriterion.SubFilter.LogicalOperator);
            Assert.Single(existsCriterion.SubFilter.Criteria);
            var subLeaf = existsCriterion.SubFilter.Criteria[0];
            Assert.Equal(CriterionKind.Comparison, subLeaf.Kind);
            Assert.Equal("statuscode", subLeaf.FieldName);
            Assert.Equal("eq", subLeaf.Operator);
            Assert.Equal("1", subLeaf.Value);
        }

        [Fact]
        public void Rule_without_kind_still_parses_as_comparison()
        {
            var childNode = Guid.NewGuid();
            var expression = $"sum(node:{childNode}.amount filter:f1)";
            var json =
                "[{" +
                "\"target\":\"sample_ordertotal\"," +
                "\"source\":\"mathexpr\"," +
                "\"expression\":\"" + expression + "\"," +
                "\"filters\":{" +
                "  \"f1\":{" +
                "    \"op\":\"and\"," +
                "    \"rules\":[" +
                "      {\"id\":\"r1\",\"column\":\"statuscode\",\"operator\":1,\"valueSource\":1,\"value\":\"1\",\"valueNodeId\":null,\"valueColumn\":null}" +
                "    ]" +
                "  }" +
                "}" +
                "}]";

            var entry = FieldMappingParser.Parse(json).Single();

            var group = entry.Filters["f1"];
            Assert.Single(group.Criteria);
            var leaf = group.Criteria[0];
            Assert.Equal(CriterionKind.Comparison, leaf.Kind);
            Assert.Equal("statuscode", leaf.FieldName);
            Assert.Equal("eq", leaf.Operator);
        }
    }
}
