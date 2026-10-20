using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Ascentix.RulesEngine.Core.Publication
{
    /// <summary>
    /// Finds the record ids a rule's configuration stores as literals (a lookup comparison value, a criterion value, a
    /// field-mapping literal). Ids of the snapshot's own rows (model nodes) are not records and are never listed.
    /// </summary>
    public static class RecordReferenceScanner
    {
        private static readonly Regex GuidPattern = new Regex(
            @"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", RegexOptions.Compiled);
        private const int LiteralSource = 1;

        /// <param name="lookupTargets">(table, column) gives the tables the lookup column can point at; empty when it is not a lookup.</param>
        public static List<RecordReference> Find(RuleSnapshot snapshot, Func<string, string, List<string>> lookupTargets)
        {
            var found = new List<RecordReference>();
            var rows = snapshot.Rows.ToDictionary(r => r.Id);
            var rowIds = new HashSet<Guid>(rows.Keys);

            bool IsLiteral(SnapshotRow row)
            {
                if (!row.Attributes.TryGetValue("asx_comparisonvaluesource", out var source) || source.Kind == "null") return true;
                return source.Kind == "option" && int.Parse(source.Value) == LiteralSource;
            }
            string NodeTable(Guid? node) =>
                node.HasValue && rows.TryGetValue(node.Value, out var n) ? Text(n, "asx_tablelogicalname") : null;
            void Add(SnapshotRow row, string attribute, Guid record, IEnumerable<string> tables)
            {
                if (rowIds.Contains(record)) return;
                if (found.Any(f => f.RowId == row.Id && f.Attribute == attribute && f.RecordId == record)) return;
                found.Add(new RecordReference { RowEntity = row.Entity, RowId = row.Id, Attribute = attribute, RecordId = record,
                    Tables = tables.Where(t => !string.IsNullOrEmpty(t)).Distinct().ToList() });
            }
            void AddLiteralGuids(SnapshotRow row, string attribute, string text, string table, string column)
            {
                if (string.IsNullOrEmpty(text)) return;
                List<string> tables = null;
                foreach (Match m in GuidPattern.Matches(text))
                {
                    var record = Guid.Parse(m.Value);
                    if (rowIds.Contains(record)) continue;
                    if (tables == null)
                        tables = table != null && !string.IsNullOrEmpty(column) ? lookupTargets(table, column) ?? new List<string>() : new List<string>();
                    Add(row, attribute, record, tables);
                }
            }

            foreach (var row in snapshot.Rows.OrderBy(r => r.Entity, StringComparer.Ordinal).ThenBy(r => r.Id))
            {
                switch (row.Entity)
                {
                    case "asx_rulecondition":
                        ScanFilterTrees(row, "asx_expressionfilters", Text(row, "asx_expressionfilters"), Add);
                        if (IsLiteral(row))
                            AddLiteralGuids(row, "asx_comparisonvalue", Text(row, "asx_comparisonvalue"),
                                NodeTable(Ref(row, "asx_tableconfig")), Text(row, "asx_comparisoncolumn"));
                        break;
                    case "asx_searchcriterion":
                        AddLiteralGuids(row, "asx_value", Text(row, "asx_value"),
                            NodeTable(SearchCriterionNode(rows, row)), Text(row, "asx_fieldname"));
                        break;
                    case "asx_nodefiltercriterion":
                        if (IsLiteral(row))
                            AddLiteralGuids(row, "asx_value", Text(row, "asx_value"),
                                NodeTable(FilterCriterionNode(rows, row)), Text(row, "asx_fieldname"));
                        break;
                    case "asx_ruleaction":
                        ScanFieldMapping(row, Text(row, "asx_fieldmapping"), Add);
                        break;
                }
            }
            return found;
        }

        private static string Text(SnapshotRow row, string attribute) =>
            row.Attributes.TryGetValue(attribute, out var v) && v.Kind == "string" ? v.Value : null;

        private static Guid? Ref(SnapshotRow row, string attribute) =>
            row.Attributes.TryGetValue(attribute, out var v) && v.Kind == "reference" ? Guid.Parse(v.Value) : (Guid?)null;

        // A RowCount condition's criteria filter the rows of the condition's own node.
        private static Guid? SearchCriterionNode(Dictionary<Guid, SnapshotRow> rows, SnapshotRow criterion)
        {
            var group = Ref(criterion, "asx_criteriagroup");
            for (var depth = 0; group.HasValue && rows.TryGetValue(group.Value, out var g) && depth < 100; depth++)
            {
                var condition = Ref(g, "asx_rulecondition");
                if (condition.HasValue && rows.TryGetValue(condition.Value, out var c)) return Ref(c, "asx_tableconfig");
                group = Ref(g, "asx_parentcriteriagroup");
            }
            return null;
        }

        // A filter group names the node it filters; a nested group inherits it from its parent group or its owning criterion's group.
        private static Guid? FilterCriterionNode(Dictionary<Guid, SnapshotRow> rows, SnapshotRow criterion)
        {
            var group = Ref(criterion, "asx_filtergroup");
            for (var depth = 0; group.HasValue && rows.TryGetValue(group.Value, out var g) && depth < 100; depth++)
            {
                var node = Ref(g, "asx_tableconfignode");
                if (node.HasValue) return node;
                var parent = Ref(g, "asx_parentfiltergroup");
                if (!parent.HasValue)
                {
                    var owner = Ref(g, "asx_owningcriterion");
                    if (owner.HasValue && rows.TryGetValue(owner.Value, out var o)) parent = Ref(o, "asx_filtergroup");
                }
                group = parent;
            }
            return null;
        }

        private static XElement Load(string json)
        {
            try
            {
                using (var reader = JsonReaderWriterFactory.CreateJsonReader(Encoding.UTF8.GetBytes(json), XmlDictionaryReaderQuotas.Max))
                    return XElement.Load(reader);
            }
            catch (Exception e) when (e is XmlException || e is ArgumentException) { return null; }
        }

        private static void ScanFilterTrees(SnapshotRow row, string attribute, string json, Action<SnapshotRow, string, Guid, IEnumerable<string>> add)
        {
            if (string.IsNullOrWhiteSpace(json)) return;
            var root = Load(json);
            if (root != null) ScanLeaves(row, attribute, root, add);
        }

        // A criteria-tree leaf ({kind:"rule", column, valueSource, value, valueNodeId}) compares a column with a literal when its
        // value source is blank or Literal. The tree names no table (the filter targets the aggregate's own node), so Tables stay empty.
        // valueNodeId and collectionNodeId address model nodes and are never read.
        private static void ScanLeaves(SnapshotRow row, string attribute, XElement tree, Action<SnapshotRow, string, Guid, IEnumerable<string>> add)
        {
            foreach (var leaf in tree.DescendantsAndSelf().Where(e => e.Elements().Any(c => c.Name.LocalName == "kind" && c.Value == "rule")))
            {
                var source = leaf.Elements().FirstOrDefault(c => c.Name.LocalName == "valueSource")?.Value;
                if (!string.IsNullOrEmpty(source) && source != "1") continue;
                var value = leaf.Elements().FirstOrDefault(c => c.Name.LocalName == "value");
                if (value == null) continue;
                // A multi-value comparison holds an array of literals.
                var literals = !value.HasElements ? new[] { value }
                    : (string)value.Attribute("type") == "array" ? value.Elements().Where(item => !item.HasElements).ToArray() : new XElement[0];
                foreach (var literal in literals)
                    foreach (Match m in GuidPattern.Matches(literal.Value))
                        add(row, attribute, Guid.Parse(m.Value), new string[0]);
            }
        }

        // Only literal entries carry record ids; node, template, dateexpr and the other sources address model nodes.
        private static void ScanFieldMapping(SnapshotRow action, string json, Action<SnapshotRow, string, Guid, IEnumerable<string>> add)
        {
            if (string.IsNullOrWhiteSpace(json)) return;
            var root = Load(json);
            if (root == null) return;
            XElement Child(XElement e, string name) => e.Elements().FirstOrDefault(x => x.Name.LocalName == name);
            foreach (var entry in root.Elements())
            {
                if (Child(entry, "source")?.Value == "mathexpr")
                {
                    var filters = Child(entry, "filters");
                    if (filters != null) ScanLeaves(action, "asx_fieldmapping", filters, add);
                    continue;
                }
                if (Child(entry, "source")?.Value != "literal") continue;
                var value = Child(entry, "value");
                if (value == null) continue;
                if (value.HasElements)
                {
                    if (Guid.TryParse(Child(value, "id")?.Value, out var id))
                        add(action, "asx_fieldmapping", id, new[] { Child(value, "logicalname")?.Value });
                }
                else
                    foreach (Match m in GuidPattern.Matches(value.Value))
                        add(action, "asx_fieldmapping", Guid.Parse(m.Value), new string[0]);
            }
        }
    }
}
