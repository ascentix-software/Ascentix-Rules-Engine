using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Actions
{
    /// <summary>Collects the tableconfig node ids and root-record columns a parsed field-mapping
    /// entry references across all sources (node copies, template tokens, dateexpr anchors). An
    /// implementation detail of <c>RuleReferences</c>: consumers read the reference set's named
    /// answers, never this per-entry walk.</summary>
    internal static class FieldMappingReferences
    {
        public static IEnumerable<Guid> NodeIds(FieldMappingEntry entry)
        {
            switch (entry.Source)
            {
                case "node":
                case "ref":
                    if (entry.Node.HasValue) yield return entry.Node.Value;
                    break;
                case "template":
                    foreach (var seg in TemplateRenderer.Tokenize(entry.Template ?? "", $"Field mapping for '{entry.Target}'"))
                        if (!seg.IsLiteral && seg.Node.HasValue) yield return seg.Node.Value;
                    break;
                case "dateexpr":
                    if (entry.AnchorNode.HasValue) yield return entry.AnchorNode.Value;
                    break;
                case "mathexpr":
                    foreach (var r in MathExpr.ExtractRefs(
                                 MathExpr.Parse(entry.Expression ?? "", $"Field mapping for '{entry.Target}'")))
                        if (r.node.HasValue) yield return r.node.Value;
                    if (entry.Filters != null)
                        foreach (var group in entry.Filters.Values)
                            foreach (var id in FilterCriterionNodeIds(group))
                                yield return id;
                    break;
            }
        }

        /// <summary>Recursively walks a node-filter group tree (criteria + child groups) and
        /// yields every criterion's <see cref="NodeFilterCriterion.ComparisonValueNodeId"/> that
        /// is set, so those single-cardinality value-nodes get config-loaded and queried. For a
        /// <see cref="CriterionKind.Exists"/> criterion, also yields its
        /// <see cref="NodeFilterCriterion.CollectionNodeId"/> and recurses into its
        /// <see cref="NodeFilterCriterion.SubFilter"/> (which may itself hold FieldReference
        /// value-nodes to seed). Shared by the aggregate (JSON) filter walk here and the
        /// condition (record) filter walk in <c>RulesEngineRunner</c>.</summary>
        public static IEnumerable<Guid> FilterCriterionNodeIds(NodeFilterGroup group)
        {
            if (group == null) yield break;

            if (group.Criteria != null)
                foreach (var crit in group.Criteria)
                {
                    if (crit.ComparisonValueNodeId.HasValue) yield return crit.ComparisonValueNodeId.Value;
                    if (crit.Kind == CriterionKind.Exists)
                    {
                        if (crit.CollectionNodeId.HasValue) yield return crit.CollectionNodeId.Value;
                        foreach (var id in FilterCriterionNodeIds(crit.SubFilter))
                            yield return id;
                    }
                }

            if (group.ChildGroups != null)
                foreach (var child in group.ChildGroups)
                    foreach (var id in FilterCriterionNodeIds(child))
                        yield return id;
        }

        /// <summary>Node ids that must be SINGLE-cardinality (scalar operands): node/ref, template
        /// tokens, dateexpr anchor, and mathexpr scalar {node:...} operands. Excludes mathexpr
        /// aggregate operands, which read a many-cardinality collection (see <see cref="AggregateNodeIds"/>).</summary>
        public static IEnumerable<Guid> SingleCardinalityNodeIds(FieldMappingEntry entry)
        {
            switch (entry.Source)
            {
                case "node":
                case "ref":
                    if (entry.Node.HasValue) yield return entry.Node.Value;
                    break;
                case "template":
                    foreach (var seg in TemplateRenderer.Tokenize(entry.Template ?? "", $"Field mapping for '{entry.Target}'"))
                        if (!seg.IsLiteral && seg.Node.HasValue) yield return seg.Node.Value;
                    break;
                case "dateexpr":
                    if (entry.AnchorNode.HasValue) yield return entry.AnchorNode.Value;
                    break;
                case "mathexpr":
                    foreach (var r in MathExpr.ScalarRefs(
                                 MathExpr.Parse(entry.Expression ?? "", $"Field mapping for '{entry.Target}'")))
                        if (r.node.HasValue) yield return r.node.Value;
                    break;
            }
        }

        /// <summary>Node ids that must be MANY-cardinality (child) collections: mathexpr aggregate
        /// operands (sum/avg/min/max/count). Empty for every other source.</summary>
        public static IEnumerable<Guid> AggregateNodeIds(FieldMappingEntry entry)
        {
            foreach (var a in AggregateNodes(entry)) yield return a.Node;
        }

        /// <summary>The mathexpr aggregate operands themselves (node, column and <c>filter:</c>
        /// key), so a caller can keep the filter-key provenance. Empty for every other source.</summary>
        public static IEnumerable<AggregateNode> AggregateNodes(FieldMappingEntry entry)
        {
            if (entry.Source == "mathexpr")
                foreach (var a in MathExpr.AggregateNodes(
                             MathExpr.Parse(entry.Expression ?? "", $"Field mapping for '{entry.Target}'")))
                    yield return a;
        }

        public static IEnumerable<string> RootColumns(FieldMappingEntry entry)
        {
            switch (entry.Source)
            {
                case "root":
                    if (!string.IsNullOrWhiteSpace(entry.Column)) yield return entry.Column;
                    break;
                case "template":
                    foreach (var seg in TemplateRenderer.Tokenize(entry.Template ?? "", $"Field mapping for '{entry.Target}'"))
                        if (!seg.IsLiteral && !seg.Node.HasValue && !string.IsNullOrWhiteSpace(seg.Column))
                            yield return seg.Column;
                    break;
                case "dateexpr":
                    if (entry.AnchorKind == "field" && !entry.AnchorNode.HasValue
                        && !string.IsNullOrWhiteSpace(entry.AnchorColumn))
                        yield return entry.AnchorColumn;
                    break;
                case "mathexpr":
                    foreach (var r in MathExpr.ExtractRefs(
                                 MathExpr.Parse(entry.Expression ?? "", $"Field mapping for '{entry.Target}'")))
                        if (!r.node.HasValue && !string.IsNullOrWhiteSpace(r.column)) yield return r.column;
                    break;
            }
        }
    }
}
