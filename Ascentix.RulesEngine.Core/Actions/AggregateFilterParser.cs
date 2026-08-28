using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Actions
{
    /// <summary>
    /// Deserializes a mathexpr field-mapping entry's "filters" JSON map
    /// (<c>{ "&lt;key&gt;": &lt;criteria-tree&gt; }</c>) into the node-filtered-condition
    /// engine model: <see cref="NodeFilterGroup"/>/<see cref="NodeFilterCriterion"/>.
    /// The criteria-tree shape mirrors the client model (client/src/editor/model/nodeFilter.ts):
    /// a group is <c>{ kind:"group", op:"and"|"or", rules:[...] }</c>; a leaf is
    /// <c>{ kind:"rule", column, operator (1..10), valueSource (1=Literal|2=FieldReference),
    /// value, valueNodeId, valueColumn }</c>. The tree has no per-node target: the filter always
    /// targets the aggregate's own (many-cardinality) node. Reads the already-loaded
    /// <see cref="XElement"/> fragment produced by <c>JsonReaderWriterFactory</c> (the same
    /// rendering <see cref="FieldMappingParser"/> uses). Sandbox-safe.
    /// </summary>
    public static class AggregateFilterParser
    {
        public static Dictionary<string, NodeFilterGroup> Parse(XElement filtersElement)
        {
            var result = new Dictionary<string, NodeFilterGroup>();
            if (filtersElement == null) return result;

            foreach (var keyElement in filtersElement.Elements())
            {
                var key = keyElement.Name.LocalName;
                result[key] = ParseGroup(keyElement, key);
            }

            return result;
        }

        private static NodeFilterGroup ParseGroup(XElement groupElement, string filterKey)
        {
            var op = ChildValue(groupElement, "op");
            LogicalOperator logicalOperator;
            switch (op)
            {
                case "and": logicalOperator = LogicalOperator.And; break;
                case "or": logicalOperator = LogicalOperator.Or; break;
                default:
                    throw new InvalidPluginExecutionException(
                        $"asx_fieldmapping filter '{filterKey}' has unknown op '{op}'. Expected 'and' or 'or'.");
            }

            var group = new NodeFilterGroup { LogicalOperator = logicalOperator };

            var rulesElement = ChildElement(groupElement, "rules");
            if (rulesElement != null)
            {
                foreach (var item in rulesElement.Elements())
                {
                    var kind = ChildValue(item, "kind");
                    switch (kind)
                    {
                        case "rule":
                        case null:
                            // Back-compat: a rule item with no 'kind' is a Comparison leaf.
                            group.Criteria.Add(ParseLeaf(item, filterKey));
                            break;
                        case "group":
                            group.ChildGroups.Add(ParseGroup(item, filterKey));
                            break;
                        case "exists":
                            group.Criteria.Add(ParseExists(item, filterKey));
                            break;
                        default:
                            throw new InvalidPluginExecutionException(
                                $"asx_fieldmapping filter '{filterKey}' has a rule with unknown kind " +
                                $"'{kind}'. Expected 'rule', 'group', or 'exists'.");
                    }
                }
            }

            return group;
        }

        private static NodeFilterCriterion ParseLeaf(XElement item, string filterKey)
        {
            var column = ChildValue(item, "column");
            if (string.IsNullOrWhiteSpace(column))
                throw new InvalidPluginExecutionException(
                    $"asx_fieldmapping filter '{filterKey}' has a rule missing 'column'.");

            var operatorRaw = ChildValue(item, "operator");
            if (!int.TryParse(operatorRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var operatorNumber))
                throw new InvalidPluginExecutionException(
                    $"asx_fieldmapping filter '{filterKey}' rule on '{column}' has a missing or invalid 'operator'.");

            var valueSourceRaw = ChildValue(item, "valueSource");
            var valueSourceNumber = (int)ComparisonValueSource.Literal;
            if (!string.IsNullOrEmpty(valueSourceRaw) &&
                !int.TryParse(valueSourceRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out valueSourceNumber))
                throw new InvalidPluginExecutionException(
                    $"asx_fieldmapping filter '{filterKey}' rule on '{column}' has an invalid 'valueSource'.");

            Guid? valueNodeId = null;
            var valueNodeRaw = ChildValue(item, "valueNodeId");
            if (!string.IsNullOrEmpty(valueNodeRaw))
            {
                if (Guid.TryParse(valueNodeRaw, out var parsed)) valueNodeId = parsed;
                else throw new InvalidPluginExecutionException(
                    $"asx_fieldmapping filter '{filterKey}' rule on '{column}' has an invalid 'valueNodeId'.");
            }

            return new NodeFilterCriterion
            {
                Kind = CriterionKind.Comparison,
                FieldName = column,
                Operator = TokenFor(operatorNumber, filterKey, column),
                Value = ChildValue(item, "value"),
                ValueSource = (ComparisonValueSource)valueSourceNumber,
                ComparisonValueNodeId = valueNodeId,
                ComparisonValueColumn = ChildValue(item, "valueColumn"),
            };
        }

        private static NodeFilterCriterion ParseExists(XElement item, string filterKey)
        {
            var collectionNodeRaw = ChildValue(item, "collectionNodeId");
            if (!Guid.TryParse(collectionNodeRaw, out var collectionNodeId))
                throw new InvalidPluginExecutionException(
                    $"asx_fieldmapping filter '{filterKey}' has an exists rule with a missing or invalid 'collectionNodeId'.");

            var minCount = ParseNullableInt(item, "minCount", filterKey);
            var maxCount = ParseNullableInt(item, "maxCount", filterKey);

            var subElement = ChildElement(item, "sub");
            if (subElement == null)
                throw new InvalidPluginExecutionException(
                    $"asx_fieldmapping filter '{filterKey}' has an exists rule missing 'sub'.");

            return new NodeFilterCriterion
            {
                Kind = CriterionKind.Exists,
                CollectionNodeId = collectionNodeId,
                MinCount = minCount,
                MaxCount = maxCount,
                SubFilter = ParseGroup(subElement, filterKey),
            };
        }

        private static int? ParseNullableInt(XElement item, string name, string filterKey)
        {
            var raw = ChildValue(item, name);
            if (string.IsNullOrEmpty(raw)) return null;
            if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value))
                throw new InvalidPluginExecutionException(
                    $"asx_fieldmapping filter '{filterKey}' has an exists rule with an invalid '{name}'.");
            return value;
        }

        /// <summary>Operator code (1..10, the client <c>ComparisonOperator</c> numbers) → the
        /// engine's string operator token. Inverse of the client's <c>operatorToFetchOp</c> table.</summary>
        internal static string TokenFor(int op, string filterKey, string column)
        {
            switch (op)
            {
                case 1: return "eq";
                case 2: return "ne";
                case 3: return "gt";
                case 4: return "ge";
                case 5: return "lt";
                case 6: return "le";
                case 7: return "contains";
                case 8: return "not-contains";
                case 9: return "null";
                case 10: return "not-null";
                default:
                    throw new InvalidPluginExecutionException(
                        $"asx_fieldmapping filter '{filterKey}' rule on '{column}' has unknown operator {op}.");
            }
        }

        private static XElement ChildElement(XElement parent, string name) =>
            parent?.Elements().FirstOrDefault(e => e.Name.LocalName == name);

        // Returns null both when the child is absent and when it is present as a JSON null
        // (JsonReaderWriterFactory renders JSON null as an empty element with type="null").
        private static string ChildValue(XElement parent, string name)
        {
            var el = ChildElement(parent, name);
            if (el == null) return null;
            if (el.Attribute("type")?.Value == "null") return null;
            return el.Value;
        }
    }
}
