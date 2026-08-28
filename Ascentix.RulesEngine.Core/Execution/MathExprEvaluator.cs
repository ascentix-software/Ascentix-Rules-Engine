using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>
    /// Evaluates a MathExpr AST against the root record and related-node records (from the
    /// QueryResultCache) in decimal arithmetic. Single-cardinality nodes are resolved to zero or one
    /// record; child-collection aggregates (sum, avg, min, max, count) reduce multiple records,
    /// optionally filtered first, per-row, through a NodeFilterGroup (AggregateNode.FilterKey looked
    /// up in the caller-supplied filters map) via NodeFilterEvaluator. A null operand anywhere, or a
    /// division whose divisor evaluates to 0, makes the whole expression "no value" (TryEvaluate
    /// returns false → caller skips the write). A non-numeric operand column or an aggregate on a
    /// single-cardinality node is an author/config error (throws), mirroring the single-cardinality
    /// policy of WriteIntentResolver / DateExprEvaluator.
    /// </summary>
    public static class MathExprEvaluator
    {
        /// <summary>Back-compat overload for callers that never filter aggregates (e.g. Expression
        /// conditions, which have no filters sidecar).</summary>
        public static bool TryEvaluate(MathExprNode ast, Entity root, QueryResultCache cache,
            TableConfigTree tree, string errorContext, out decimal result)
        {
            return TryEvaluate(ast, root, cache, tree, errorContext, null, null, out result);
        }

        public static bool TryEvaluate(MathExprNode ast, Entity root, QueryResultCache cache,
            TableConfigTree tree, string errorContext,
            IReadOnlyDictionary<string, NodeFilterGroup> filters, NodeFilterEvaluator filterEval,
            out decimal result)
        {
            var value = Eval(ast, root, cache, tree, errorContext, filters, filterEval);
            result = value ?? 0m;
            return value.HasValue;
        }

        private static decimal? Eval(MathExprNode node, Entity root, QueryResultCache cache,
            TableConfigTree tree, string ctx,
            IReadOnlyDictionary<string, NodeFilterGroup> filters, NodeFilterEvaluator filterEval)
        {
            switch (node)
            {
                case NumberNode n:
                    return n.Value;
                case ColumnRefNode c:
                    return ResolveColumn(c, root, cache, tree, ctx);
                case AggregateNode a:
                    return ResolveAggregate(a, cache, tree, ctx, filters, filterEval);
                case UnaryNode u:
                    var v = Eval(u.Operand, root, cache, tree, ctx, filters, filterEval);
                    return v.HasValue ? (decimal?)(-v.Value) : null;
                case BinaryNode b:
                    var l = Eval(b.Left, root, cache, tree, ctx, filters, filterEval);
                    if (!l.HasValue) return null;
                    var r = Eval(b.Right, root, cache, tree, ctx, filters, filterEval);
                    if (!r.HasValue) return null;
                    switch (b.Op)
                    {
                        case '+': return l.Value + r.Value;
                        case '-': return l.Value - r.Value;
                        case '*': return l.Value * r.Value;
                        case '/': return r.Value == 0m ? (decimal?)null : l.Value / r.Value;
                    }
                    return null;
                default:
                    return null;
            }
        }

        private static decimal? ResolveColumn(ColumnRefNode c, Entity root, QueryResultCache cache,
            TableConfigTree tree, string ctx)
        {
            var record = ResolveRecord(c.Node, root, cache, tree, ctx);
            if (record == null || string.IsNullOrEmpty(c.Column) || !record.Contains(c.Column))
                return null;
            var raw = record[c.Column];
            if (raw is AliasedValue aliased) raw = aliased.Value;
            if (raw == null) return null;
            return ToNumeric(raw, c.Column, ctx);
        }

        private static Entity ResolveRecord(Guid? nodeId, Entity root, QueryResultCache cache,
            TableConfigTree tree, string ctx)
        {
            if (!nodeId.HasValue) return root;
            if (!tree.TryGetNode(nodeId.Value, out var node))
                throw new InvalidPluginExecutionException(
                    $"{ctx}: calculation references node {nodeId} which is not in the rule's config tree.");
            tree.RequireSingleCardinality(node.Id, ctx);
            var records = cache.Get(node.Id);
            if (records.Count > 1)
                throw new InvalidPluginExecutionException(
                    $"{ctx}: calculation node '{node.TableLogicalName}' resolved {records.Count} records; expected at most one.");
            return records.Count == 0 ? null : records[0];
        }

        private static decimal ToNumeric(object raw, string column, string ctx)
        {
            switch (raw)
            {
                case int i: return i;
                case long l: return l;
                case decimal d: return d;
                case double db: return (decimal)db;
                case Money m: return m.Value;
                default:
                    throw new InvalidPluginExecutionException(
                        $"{ctx}: calculation operand '{column}' is not a numeric value.");
            }
        }

        private static decimal? ResolveAggregate(AggregateNode a, QueryResultCache cache,
            TableConfigTree tree, string ctx,
            IReadOnlyDictionary<string, NodeFilterGroup> filters, NodeFilterEvaluator filterEval)
        {
            if (!tree.TryGetNode(a.Node, out var node))
                throw new InvalidPluginExecutionException(
                    $"{ctx}: aggregate references node {a.Node} which is not in the rule's config tree.");
            if (tree.TrySingleCardinality(node.Id))
                throw new InvalidPluginExecutionException(
                    $"{ctx}: aggregate node '{node.TableLogicalName}' is single-cardinality; aggregate only over a child collection.");

            var rows = cache.Get(a.Node);
            if (a.FilterKey != null)
            {
                if (filters == null || !filters.TryGetValue(a.FilterKey, out var fg))
                    throw new InvalidPluginExecutionException(
                        $"{ctx}: aggregate references filter '{a.FilterKey}' which is not defined.");
                rows = rows.Where(r => filterEval.EvaluateFilterGroup(fg, new List<Entity> { r }, a.Node)).ToList();
            }

            if (a.Func == AggregateFunc.Count) return rows.Count;

            var vals = new List<decimal>();
            foreach (var r in rows)
            {
                if (!r.Contains(a.Column)) continue;
                var raw = r[a.Column];
                if (raw is AliasedValue av) raw = av.Value;
                if (raw == null) continue;
                vals.Add(ToNumeric(raw, a.Column, ctx));
            }

            switch (a.Func)
            {
                case AggregateFunc.Sum:
                    decimal sum = 0m; foreach (var v in vals) sum += v; return sum; // empty => 0
                case AggregateFunc.Avg:
                    if (vals.Count == 0) return null;
                    decimal s = 0m; foreach (var v in vals) s += v; return s / vals.Count;
                case AggregateFunc.Min:
                    if (vals.Count == 0) return null;
                    decimal mn = vals[0]; foreach (var v in vals) if (v < mn) mn = v; return mn;
                case AggregateFunc.Max:
                    if (vals.Count == 0) return null;
                    decimal mx = vals[0]; foreach (var v in vals) if (v > mx) mx = v; return mx;
                default: return null;
            }
        }
    }
}
