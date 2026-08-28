using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>
    /// Column pruning for traversal fetches: computes, per CHILD-TABLE node, the exact
    /// set of columns the engine reads off that node's rows, so QueryExecutor can fetch
    /// &lt;attribute&gt; lists instead of &lt;all-attributes /&gt;. At collection scale the width
    /// of an un-pruned fetch is a sandbox-memory hazard independent of row count.
    ///
    /// Safety model (precision only where the source is fully structured):
    ///  - Collected precisely: condition LHS columns, FieldReference RHS columns, condition
    ///    Template/DateExpression node references, node-filter criterion fields + reference
    ///    RHS + EXISTS sub-filter fields, RowCount search-criteria fields, and the structural
    ///    columns traversal itself needs (the node's ChildLinkField; lookup columns of child
    ///    lookup nodes; lookup columns the ancestor-cascade reads).
    ///  - NOT pruned at all: any node in <c>unpruneableNodeIds</c>. Callers pass the rule
    ///    reference set's <c>Unpruneable</c> answer (hard readers: write-action targets,
    ///    field-mapping refs, mathexpr refs, template/dateexpr refs, message-template node
    ///    references; plus the filter-derived nodes). Those consumers read columns this
    ///    collector cannot enumerate exhaustively, and a missed column reads as silently-null,
    ///    the one failure class pruning must never introduce.
    ///  - Lookup-table nodes are never pruned: they resolve single records per parent, so
    ///    width is cheap and the blast radius of a miss is not.
    /// </summary>
    public static class TraversalColumnCollector
    {
        /// <summary>Returns column sets ONLY for child-table nodes that are safe to prune;
        /// absent nodes fetch all-attributes.</summary>
        public static Dictionary<Guid, HashSet<string>> Collect(
            TableConfigTree tree,
            List<ConditionGroup> rootGroups,
            IEnumerable<Guid> unpruneableNodeIds)
        {
            var result = new Dictionary<Guid, HashSet<string>>();
            if (tree == null || rootGroups == null) return result;

            var unpruneable = new HashSet<Guid>(unpruneableNodeIds ?? Enumerable.Empty<Guid>());

            // Candidates: child-table nodes not referenced by unstructured consumers.
            foreach (var cfg in tree.NodesOfType(TableConfigType.ChildTable))
            {
                if (unpruneable.Contains(cfg.Id)) continue;
                var cols = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                // Structural: the child link is read by NodeRelate and the ancestor cascade.
                if (!string.IsNullOrWhiteSpace(cfg.ChildLinkField)) cols.Add(cfg.ChildLinkField);
                // Structural: lookup nodes hanging off this node read their lookup column
                // from this node's rows.
                foreach (var child in tree.ChildrenOf(cfg.Id, TableConfigType.LookupTable))
                    if (!string.IsNullOrWhiteSpace(child.LookupColumnLogicalName))
                        cols.Add(child.LookupColumnLogicalName);
                result[cfg.Id] = cols;
            }
            if (result.Count == 0) return result;

            void Add(Guid? nodeId, string column)
            {
                if (!nodeId.HasValue || string.IsNullOrWhiteSpace(column)) return;
                if (result.TryGetValue(nodeId.Value, out var cols)) cols.Add(column);
            }

            foreach (var group in EnumerateGroups(rootGroups))
            {
                foreach (var c in group.Conditions ?? new List<RuleCondition>())
                {
                    Add(c.TableConfigNodeId, c.ComparisonColumn);

                    if (c.ValueSource == ComparisonValueSource.FieldReference)
                        Add(c.ComparisonValueNodeId ?? c.TableConfigNodeId, c.ComparisonValueColumn);
                    else if (c.ValueSource == ComparisonValueSource.Template &&
                             !string.IsNullOrWhiteSpace(c.ComparisonValue))
                    {
                        foreach (var seg in TemplateRenderer.Tokenize(c.ComparisonValue, $"Condition {c.Id}"))
                            if (!seg.IsLiteral && seg.Node.HasValue)
                                Add(seg.Node, seg.Column);
                    }
                    else if (c.ValueSource == ComparisonValueSource.DateExpression &&
                             !string.IsNullOrWhiteSpace(c.ComparisonValue))
                    {
                        var spec = DateExprSpec.Parse(c.ComparisonValue);
                        if (spec.AnchorKind == "field") Add(spec.AnchorNode, spec.AnchorColumn);
                    }

                    foreach (var sg in EnumerateSearchGroups(c.SearchCriteriaGroups))
                        foreach (var crit in sg.Criteria ?? new List<SearchCriterion>())
                            Add(c.TableConfigNodeId, crit.FieldName);
                }

                foreach (var filter in EnumerateFilterGroups(group.NodeFilterGroups))
                {
                    foreach (var crit in filter.Criteria ?? new List<NodeFilterCriterion>())
                    {
                        Add(filter.TableConfigNodeId, crit.FieldName);
                        if (crit.ValueSource == ComparisonValueSource.FieldReference)
                            Add(crit.ComparisonValueNodeId ?? filter.TableConfigNodeId, crit.ComparisonValueColumn);
                        if (crit.Kind == CriterionKind.Exists && crit.SubFilter != null)
                            foreach (var sub in EnumerateFilterGroups(new[] { crit.SubFilter }))
                                foreach (var sc in sub.Criteria ?? new List<NodeFilterCriterion>())
                                {
                                    Add(crit.CollectionNodeId, sc.FieldName);
                                    if (sc.ValueSource == ComparisonValueSource.FieldReference)
                                        Add(sc.ComparisonValueNodeId ?? crit.CollectionNodeId, sc.ComparisonValueColumn);
                                }
                    }
                }
            }

            return result;
        }

        private static IEnumerable<ConditionGroup> EnumerateGroups(IEnumerable<ConditionGroup> groups)
        {
            foreach (var g in groups ?? Enumerable.Empty<ConditionGroup>())
            {
                yield return g;
                foreach (var child in EnumerateGroups(g.ChildGroups)) yield return child;
            }
        }

        private static IEnumerable<NodeFilterGroup> EnumerateFilterGroups(IEnumerable<NodeFilterGroup> groups)
        {
            foreach (var g in groups ?? Enumerable.Empty<NodeFilterGroup>())
            {
                yield return g;
                foreach (var child in EnumerateFilterGroups(g.ChildGroups)) yield return child;
            }
        }

        private static IEnumerable<SearchCriteriaGroup> EnumerateSearchGroups(IEnumerable<SearchCriteriaGroup> groups)
        {
            foreach (var g in groups ?? Enumerable.Empty<SearchCriteriaGroup>())
            {
                yield return g;
                foreach (var child in EnumerateSearchGroups(g.ChildGroups)) yield return child;
            }
        }
    }
}
