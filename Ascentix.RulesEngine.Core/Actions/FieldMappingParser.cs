using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Xml.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;

namespace Ascentix.RulesEngine.Core.Actions
{
    /// <summary>
    /// Parses an asx_fieldmapping payload (a JSON array of { target, source, value|column|node|template|expression|anchor/op/amount/unit }
    /// entries) into <see cref="FieldMappingEntry"/> objects. Literal values use the RecordJson
    /// encoding (decoded via <see cref="JsonPrimitiveDecoder"/>). Template, mathexpr, and dateexpr sources are validated
    /// for proper shape (template text, expression text, anchor kind/column, op, amount, unit). Sandbox-safe.
    /// </summary>
    public static class FieldMappingParser
    {
        public static List<FieldMappingEntry> Parse(string json)
        {
            var entries = new List<FieldMappingEntry>();
            if (string.IsNullOrWhiteSpace(json)) return entries;

            XElement root;
            try
            {
                using (var reader = JsonReaderWriterFactory.CreateJsonReader(
                    Encoding.UTF8.GetBytes(json), System.Xml.XmlDictionaryReaderQuotas.Max))
                {
                    root = XElement.Load(reader);
                }
            }
            catch (System.Xml.XmlException ex)
            {
                throw new InvalidPluginExecutionException("asx_fieldmapping is not valid JSON.", ex);
            }

            // JsonReaderWriterFactory renders a JSON array as <root type="array"><item>...
            foreach (var item in root.Elements())
                entries.Add(ParseEntry(item));

            return entries;
        }

        private static FieldMappingEntry ParseEntry(XElement item)
        {
            string Child(string name) =>
                item.Elements().FirstOrDefault(e => e.Name.LocalName == name)?.Value;

            var target = Child("target");
            var source = Child("source");
            if (string.IsNullOrWhiteSpace(target))
                throw new InvalidPluginExecutionException("asx_fieldmapping entry is missing 'target'.");

            var entry = new FieldMappingEntry { Target = target, Source = source };

            switch (source)
            {
                case "literal":
                    var valueEl = item.Elements().FirstOrDefault(e => e.Name.LocalName == "value");
                    entry.Value = valueEl == null ? null : JsonPrimitiveDecoder.Decode(valueEl);
                    break;
                case "root":
                    entry.Column = Child("column");
                    break;
                case "node":
                    entry.Column = Child("column");
                    var nodeRaw = Child("node");
                    if (Guid.TryParse(nodeRaw, out var nodeId)) entry.Node = nodeId;
                    else throw new InvalidPluginExecutionException(
                        $"asx_fieldmapping 'node' for target '{target}' is not a valid GUID.");
                    break;
                case "ref":
                    var refNodeRaw = Child("node");
                    if (Guid.TryParse(refNodeRaw, out var refNodeId)) entry.Node = refNodeId;
                    else throw new InvalidPluginExecutionException(
                        $"asx_fieldmapping 'node' for target '{target}' is not a valid GUID.");
                    break;
                case "template":
                    entry.Template = Child("template");
                    if (string.IsNullOrEmpty(entry.Template))
                        throw new InvalidPluginExecutionException(
                            $"asx_fieldmapping template entry for target '{target}' is missing 'template'.");
                    break;
                case "mathexpr":
                    entry.Expression = Child("expression");
                    if (string.IsNullOrWhiteSpace(entry.Expression))
                        throw new InvalidPluginExecutionException(
                            $"asx_fieldmapping mathexpr entry for target '{target}' is missing 'expression'.");
                    // Validate by parsing; the AST is rebuilt at resolve time (entry stays a plain
                    // data holder). A malformed expression fails here with a contextual message.
                    var mathAst = Ascentix.RulesEngine.Core.Execution.MathExpr.Parse(
                        entry.Expression, $"asx_fieldmapping mathexpr for target '{target}'");

                    var filtersElement = item.Elements().FirstOrDefault(e => e.Name.LocalName == "filters");
                    entry.Filters = filtersElement != null
                        ? AggregateFilterParser.Parse(filtersElement)
                        : new Dictionary<string, Ascentix.RulesEngine.Core.Models.NodeFilterGroup>();

                    ValidateFilterKeyIntegrity(mathAst, entry, target);
                    break;
                case "dateexpr":
                    ParseDateExpr(item, entry, target);
                    break;
                default:
                    throw new InvalidPluginExecutionException(
                        $"asx_fieldmapping entry for target '{target}' has unknown source '{source}'. " +
                        "Expected 'literal', 'root', 'node', 'ref', 'template', 'mathexpr', or 'dateexpr'.");
            }

            return entry;
        }

        private static void ParseDateExpr(XElement item, FieldMappingEntry entry, string target)
        {
            var spec = DateExprSpec.ParseFrom(item, $"asx_fieldmapping dateexpr for target '{target}'");

            entry.AnchorKind = spec.AnchorKind;
            entry.AnchorNode = spec.AnchorNode;
            entry.AnchorColumn = spec.AnchorColumn;
            entry.Op = spec.Op;
            entry.Amount = spec.Amount;
            entry.Unit = spec.Unit;
        }

        /// <summary>Every `filter:&lt;key&gt;` referenced by an aggregate in the expression must
        /// have a matching entry in the mathexpr entry's `filters` map, and every `filters` entry
        /// must be referenced by some aggregate. Otherwise the mapping is ambiguous (a filter
        /// with no aggregate to apply to, or an aggregate whose filter was never defined).</summary>
        private static void ValidateFilterKeyIntegrity(
            Ascentix.RulesEngine.Core.Execution.MathExprNode ast, FieldMappingEntry entry, string target)
        {
            var referencedKeys = new HashSet<string>(
                Ascentix.RulesEngine.Core.Execution.MathExpr.AggregateNodes(ast)
                    .Select(a => a.FilterKey)
                    .Where(k => k != null));

            var missing = referencedKeys.Where(k => !entry.Filters.ContainsKey(k)).ToList();
            if (missing.Count > 0)
                throw new InvalidPluginExecutionException(
                    $"asx_fieldmapping mathexpr entry for target '{target}' references filter key(s) " +
                    $"'{string.Join("', '", missing)}' with no matching entry in 'filters'.");

            var orphaned = entry.Filters.Keys.Where(k => !referencedKeys.Contains(k)).ToList();
            if (orphaned.Count > 0)
                throw new InvalidPluginExecutionException(
                    $"asx_fieldmapping mathexpr entry for target '{target}' has 'filters' entry/entries " +
                    $"'{string.Join("', '", orphaned)}' not referenced by any aggregate in 'expression'.");
        }
    }
}
