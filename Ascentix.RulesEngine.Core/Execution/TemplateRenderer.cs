using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>
    /// Renders a field-mapping template (literal text with {root.column} and {node:guid.column}
    /// tokens, where {{ and }} escape braces) against the root record and single-cardinality
    /// related nodes. Null/missing values render as empty string; a malformed or unknown token
    /// is a configuration error. Values are formatted for humans: option sets and booleans via
    /// IOptionLabelProvider, lookups via EntityReference.Name, otherwise the record's
    /// FormattedValues when present, else invariant ToString.
    /// </summary>
    public class TemplateRenderer
    {
        public readonly struct Segment
        {
            public bool IsLiteral { get; }
            public string Text { get; }
            public Guid? Node { get; }
            public string Column { get; }
            private Segment(bool isLiteral, string text, Guid? node, string column)
            { IsLiteral = isLiteral; Text = text; Node = node; Column = column; }
            public static Segment Literal(string text) => new Segment(true, text, null, null);
            public static Segment Field(Guid? node, string column) => new Segment(false, null, node, column);
        }

        private readonly TableConfigTree _tree;
        private readonly IOptionLabelProvider _labels;

        public TemplateRenderer(TableConfigTree tree, IOptionLabelProvider labels)
        {
            _tree = tree ?? TableConfigTree.Empty;
            _labels = labels;
        }

        public string Render(string template, Entity root, QueryResultCache cache, string errorContext)
        {
            if (template == null)
                throw new InvalidPluginExecutionException(
                    $"{errorContext}: no message template is configured.");

            var sb = new StringBuilder();
            foreach (var seg in Tokenize(template, errorContext))
            {
                if (seg.IsLiteral) { sb.Append(seg.Text); continue; }

                Entity record;
                string table;
                if (seg.Node == null)
                {
                    record = root;
                    table = root?.LogicalName;
                }
                else
                {
                    if (!_tree.TryGetNode(seg.Node.Value, out var node))
                        throw new InvalidPluginExecutionException(
                            $"{errorContext}: template token references node {seg.Node} which is not in the rule's config tree.");
                    _tree.RequireSingleCardinality(node.Id, errorContext);
                    var records = cache.Get(node.Id);
                    if (records.Count > 1)
                        throw new InvalidPluginExecutionException(
                            $"{errorContext}: template token node '{node.TableLogicalName}' resolved {records.Count} records; " +
                            "expected at most one.");
                    record = records.Count == 0 ? null : records[0];
                    table = node.TableLogicalName;
                }
                sb.Append(FormatValue(record, table, seg.Column));
            }
            return sb.ToString();
        }

        /// <summary>The distinct node ids referenced by {node:&lt;guid&gt;.col} tokens in a template.
        /// Lenient: used at seed time to load/query those nodes before rendering; a malformed
        /// template yields no ids here and surfaces its real error later in <see cref="Render"/>.</summary>
        internal static IEnumerable<Guid> NodeReferences(string template)
        {
            if (string.IsNullOrEmpty(template)) return Enumerable.Empty<Guid>();
            List<Segment> segs;
            try { segs = Tokenize(template, "seed"); }
            catch (InvalidPluginExecutionException) { return Enumerable.Empty<Guid>(); }
            return segs.Where(s => !s.IsLiteral && s.Node.HasValue).Select(s => s.Node.Value).Distinct();
        }

        // Tokenize/NodeReferences are implementation details of RuleReferences (the rule
        // reference set) and of Render; consumers read the reference set's named answers.
        internal static List<Segment> Tokenize(string template, string errorContext)
        {
            var segs = new List<Segment>();
            var text = new StringBuilder();
            for (var i = 0; i < template.Length; i++)
            {
                var c = template[i];
                if (c == '{')
                {
                    if (i + 1 < template.Length && template[i + 1] == '{') { text.Append('{'); i++; continue; }
                    var close = template.IndexOf('}', i + 1);
                    if (close < 0)
                        throw new InvalidPluginExecutionException($"{errorContext}: template has an unclosed '{{' token.");
                    if (text.Length > 0) { segs.Add(Segment.Literal(text.ToString())); text.Clear(); }
                    segs.Add(ParseToken(template.Substring(i + 1, close - i - 1), errorContext));
                    i = close;
                }
                else if (c == '}')
                {
                    if (i + 1 < template.Length && template[i + 1] == '}') { text.Append('}'); i++; continue; }
                    throw new InvalidPluginExecutionException(
                        $"{errorContext}: template has a stray '}}' (use '}}}}' for a literal brace).");
                }
                else text.Append(c);
            }
            if (text.Length > 0) segs.Add(Segment.Literal(text.ToString()));
            return segs;
        }

        private static Segment ParseToken(string token, string errorContext)
        {
            if (token.StartsWith("root.", StringComparison.Ordinal))
            {
                var column = token.Substring("root.".Length);
                if (column.Length == 0)
                    throw new InvalidPluginExecutionException(
                        $"{errorContext}: template token '{{{token}}}' is missing a column name.");
                return Segment.Field(null, column);
            }
            if (token.StartsWith("node:", StringComparison.Ordinal))
            {
                var rest = token.Substring("node:".Length);
                var dot = rest.IndexOf('.');
                if (dot <= 0 || dot == rest.Length - 1)
                    throw new InvalidPluginExecutionException(
                        $"{errorContext}: template token '{{{token}}}' must be '{{node:<guid>.<column>}}'.");
                if (!Guid.TryParse(rest.Substring(0, dot), out var id))
                    throw new InvalidPluginExecutionException(
                        $"{errorContext}: template token '{{{token}}}' does not contain a valid node GUID.");
                return Segment.Field(id, rest.Substring(dot + 1));
            }
            throw new InvalidPluginExecutionException(
                $"{errorContext}: unknown template token '{{{token}}}'. Expected '{{root.<column>}}' or '{{node:<guid>.<column>}}'.");
        }

        private string FormatValue(Entity record, string table, string column)
        {
            if (record == null || string.IsNullOrEmpty(column) || !record.Contains(column))
                return "";
            var value = record[column];
            if (value is AliasedValue aliased) value = aliased.Value;
            if (value == null) return "";

            switch (value)
            {
                case OptionSetValueCollection multi:
                {
                    var labels = multi.Select(o => _labels?.GetOptionLabel(table, column, o.Value)).ToList();
                    if (labels.Count > 0 && labels.All(l => l != null)) return string.Join(", ", labels);
                    return Formatted(record, column)
                        ?? string.Join(", ", multi.Select(o => o.Value.ToString(CultureInfo.InvariantCulture)));
                }
                case OptionSetValue os:
                    return _labels?.GetOptionLabel(table, column, os.Value)
                        ?? Formatted(record, column)
                        ?? os.Value.ToString(CultureInfo.InvariantCulture);
                case bool b:
                    return _labels?.GetOptionLabel(table, column, b ? 1 : 0)
                        ?? Formatted(record, column)
                        ?? (b ? "true" : "false");
                case EntityReference er:
                    return !string.IsNullOrEmpty(er.Name) ? er.Name : Formatted(record, column) ?? "";
                case Money m:
                    return Formatted(record, column) ?? m.Value.ToString(CultureInfo.InvariantCulture);
                case DateTime dt:
                    return Formatted(record, column) ?? dt.ToString(CultureInfo.InvariantCulture);
                default:
                    return Formatted(record, column) ?? Convert.ToString(value, CultureInfo.InvariantCulture);
            }
        }

        private static string Formatted(Entity record, string column) =>
            record.FormattedValues != null && record.FormattedValues.ContainsKey(column)
                ? record.FormattedValues[column] : null;
    }
}
