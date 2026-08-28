using System;
using System.Collections.Generic;
using System.Globalization;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>AST for a numeric field-mapping expression (source == "mathexpr").</summary>
    public abstract class MathExprNode { }
    public sealed class NumberNode : MathExprNode { public decimal Value; }
    public sealed class ColumnRefNode : MathExprNode { public Guid? Node; public string Column; }
    public sealed class UnaryNode : MathExprNode { public MathExprNode Operand; } // arithmetic negate
    public sealed class BinaryNode : MathExprNode { public char Op; public MathExprNode Left, Right; }
    public enum AggregateFunc { Sum, Avg, Min, Max, Count }
    public sealed class AggregateNode : MathExprNode { public AggregateFunc Func; public Guid Node; public string Column; public string FilterKey; } // Column null for Count; FilterKey null when unfiltered

    /// <summary>
    /// Recursive-descent parser for a numeric expression: numeric literals, {root.col} /
    /// {node:guid.col} tokens (same grammar as TemplateRenderer), aggregate operands
    /// (sum/avg/min/max/count), binary + - * /, unary -, and parentheses with standard
    /// precedence (* / over + -), left-associative. Pure and sandbox-safe (no eval).
    /// A malformed expression throws InvalidPluginExecutionException, prefixed with errorContext.
    /// </summary>
    public static class MathExpr
    {
        public static MathExprNode Parse(string expression, string errorContext)
        {
            var tokens = Tokenize(expression ?? "", errorContext);
            var pos = 0;
            var node = ParseExpr(tokens, ref pos, errorContext);
            if (pos != tokens.Count)
                throw Err(errorContext, "unexpected trailing input in expression.");
            return node;
        }

        // The three reference walks below are implementation details of RuleReferences (the
        // rule reference set); consumers read its named answers rather than walking an AST.
        internal static IEnumerable<(Guid? node, string column)> ExtractRefs(MathExprNode ast)
        {
            switch (ast)
            {
                case ColumnRefNode c: yield return (c.Node, c.Column); break;
                case AggregateNode a: yield return (a.Node, a.Column); break;
                case UnaryNode u:
                    foreach (var r in ExtractRefs(u.Operand)) yield return r; break;
                case BinaryNode b:
                    foreach (var r in ExtractRefs(b.Left)) yield return r;
                    foreach (var r in ExtractRefs(b.Right)) yield return r;
                    break;
            }
        }

        /// <summary>Scalar column operands ({root.col} / {node:guid.col}) only: must resolve to a
        /// single record, so any node they reference must be single-cardinality. Excludes aggregates.</summary>
        internal static IEnumerable<(Guid? node, string column)> ScalarRefs(MathExprNode ast)
        {
            switch (ast)
            {
                case ColumnRefNode c: yield return (c.Node, c.Column); break;
                case UnaryNode u:
                    foreach (var r in ScalarRefs(u.Operand)) yield return r; break;
                case BinaryNode b:
                    foreach (var r in ScalarRefs(b.Left)) yield return r;
                    foreach (var r in ScalarRefs(b.Right)) yield return r;
                    break;
            }
        }

        /// <summary>Aggregate operands (sum/avg/min/max/count(node:...)) only: reduce a child
        /// collection, so the node they reference must be many-cardinality.</summary>
        internal static IEnumerable<(Guid node, string column)> AggregateRefs(MathExprNode ast)
        {
            switch (ast)
            {
                case AggregateNode a: yield return (a.Node, a.Column); break;
                case UnaryNode u:
                    foreach (var r in AggregateRefs(u.Operand)) yield return r; break;
                case BinaryNode b:
                    foreach (var r in AggregateRefs(b.Left)) yield return r;
                    foreach (var r in AggregateRefs(b.Right)) yield return r;
                    break;
            }
        }

        /// <summary>Every <see cref="AggregateNode"/> in the tree (not just its node/column), so
        /// callers can inspect <see cref="AggregateNode.FilterKey"/> (e.g. field-mapping filter
        /// key-integrity checks).</summary>
        public static IEnumerable<AggregateNode> AggregateNodes(MathExprNode ast)
        {
            switch (ast)
            {
                case AggregateNode a: yield return a; break;
                case UnaryNode u:
                    foreach (var r in AggregateNodes(u.Operand)) yield return r; break;
                case BinaryNode b:
                    foreach (var r in AggregateNodes(b.Left)) yield return r;
                    foreach (var r in AggregateNodes(b.Right)) yield return r;
                    break;
            }
        }

        // ── token stream ────────────────────────────────────────────────
        private enum TokKind { Number, Ref, Agg, Plus, Minus, Star, Slash, LParen, RParen }
        private struct Tok { public TokKind Kind; public decimal Num; public Guid? Node; public string Col; public AggregateFunc Func; public string FilterKey; }

        private static List<Tok> Tokenize(string s, string ctx)
        {
            var toks = new List<Tok>();
            var i = 0;
            while (i < s.Length)
            {
                var c = s[i];
                if (char.IsWhiteSpace(c)) { i++; continue; }
                switch (c)
                {
                    case '+': toks.Add(new Tok { Kind = TokKind.Plus }); i++; continue;
                    case '-': toks.Add(new Tok { Kind = TokKind.Minus }); i++; continue;
                    case '*': toks.Add(new Tok { Kind = TokKind.Star }); i++; continue;
                    case '/': toks.Add(new Tok { Kind = TokKind.Slash }); i++; continue;
                    case '(': toks.Add(new Tok { Kind = TokKind.LParen }); i++; continue;
                    case ')': toks.Add(new Tok { Kind = TokKind.RParen }); i++; continue;
                }
                if (c == '{')
                {
                    var close = s.IndexOf('}', i + 1);
                    if (close < 0) throw Err(ctx, "expression has an unclosed '{' token.");
                    var (node, col) = ParseToken(s.Substring(i + 1, close - i - 1), ctx);
                    toks.Add(new Tok { Kind = TokKind.Ref, Node = node, Col = col });
                    i = close + 1; continue;
                }
                if (char.IsDigit(c) || c == '.')
                {
                    var start = i;
                    while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '.')) i++;
                    var lit = s.Substring(start, i - start);
                    if (!decimal.TryParse(lit, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var num))
                        throw Err(ctx, $"'{lit}' is not a valid number.");
                    toks.Add(new Tok { Kind = TokKind.Number, Num = num }); continue;
                }
                if (char.IsLetter(c))
                {
                    var start = i;
                    while (i < s.Length && char.IsLetter(s[i])) i++;
                    var name = s.Substring(start, i - start).ToLowerInvariant();
                    var func = ParseFunc(name, ctx);
                    while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
                    if (i >= s.Length || s[i] != '(') throw Err(ctx, $"'{name}' must be followed by '('.");
                    var close = s.IndexOf(')', i + 1);
                    if (close < 0) throw Err(ctx, $"'{name}(' has no closing ')'.");
                    var (node, col, filterKey) = ParseAggArg(s.Substring(i + 1, close - i - 1).Trim(), func, name, ctx);
                    toks.Add(new Tok { Kind = TokKind.Agg, Func = func, Node = node, Col = col, FilterKey = filterKey });
                    i = close + 1; continue;
                }
                throw Err(ctx, $"unexpected character '{c}' in expression.");
            }
            return toks;
        }

        // {root.<col>} or {node:<guid>.<col>}. Mirrors TemplateRenderer.ParseToken.
        private static (Guid? node, string col) ParseToken(string token, string ctx)
        {
            if (token.StartsWith("root.", StringComparison.Ordinal))
            {
                var col = token.Substring("root.".Length);
                if (col.Length == 0) throw Err(ctx, $"token '{{{token}}}' is missing a column name.");
                return (null, col);
            }
            if (token.StartsWith("node:", StringComparison.Ordinal))
            {
                var rest = token.Substring("node:".Length);
                var dot = rest.IndexOf('.');
                if (dot <= 0 || dot == rest.Length - 1)
                    throw Err(ctx, $"token '{{{token}}}' must be '{{node:<guid>.<column>}}'.");
                if (!Guid.TryParse(rest.Substring(0, dot), out var id))
                    throw Err(ctx, $"token '{{{token}}}' does not contain a valid node GUID.");
                return (id, rest.Substring(dot + 1));
            }
            throw Err(ctx, $"unknown token '{{{token}}}'. Expected '{{root.<column>}}' or '{{node:<guid>.<column>}}'.");
        }

        private static AggregateFunc ParseFunc(string name, string ctx)
        {
            switch (name)
            {
                case "sum": return AggregateFunc.Sum;
                case "avg": return AggregateFunc.Avg;
                case "min": return AggregateFunc.Min;
                case "max": return AggregateFunc.Max;
                case "count": return AggregateFunc.Count;
                default: throw Err(ctx, $"unknown function '{name}'. Expected sum, avg, min, max, or count.");
            }
        }

        // Aggregate argument is a brace-free 'node:<guid>[.<column>] [filter:<key>]'. Column required except for count.
        private static (Guid node, string col, string filterKey) ParseAggArg(string arg, AggregateFunc func, string name, string ctx)
        {
            string filterKey = null;
            var ws = arg.IndexOfAny(new[] { ' ', '\t' });
            if (ws >= 0)
            {
                var tail = arg.Substring(ws + 1).Trim();
                arg = arg.Substring(0, ws);
                if (!tail.StartsWith("filter:", StringComparison.Ordinal))
                    throw Err(ctx, $"{name}(...) has unexpected text '{tail}'; expected 'filter:<key>'.");
                filterKey = tail.Substring("filter:".Length).Trim();
                if (filterKey.Length == 0 || !IsFilterKey(filterKey))
                    throw Err(ctx, $"{name}(...) filter key '{filterKey}' must be one or more letters, digits, or underscores.");
            }
            if (!arg.StartsWith("node:", StringComparison.Ordinal))
                throw Err(ctx, $"{name}(...) argument must be 'node:<guid>{(func == AggregateFunc.Count ? "" : ".<column>")}'.");
            var rest = arg.Substring("node:".Length);
            var dot = rest.IndexOf('.');
            var guidPart = dot < 0 ? rest : rest.Substring(0, dot);
            var col = dot < 0 ? null : rest.Substring(dot + 1);
            if (!Guid.TryParse(guidPart, out var id))
                throw Err(ctx, $"{name}(...) does not contain a valid node GUID.");
            if (func == AggregateFunc.Count)
            {
                if (!string.IsNullOrEmpty(col)) throw Err(ctx, "count(...) takes no column. Use 'count(node:<guid>)'.");
            }
            else if (string.IsNullOrEmpty(col))
            {
                throw Err(ctx, $"{name}(...) needs a column. Use '{name}(node:<guid>.<column>)'.");
            }
            return (id, col, filterKey);
        }

        private static bool IsFilterKey(string s)
        {
            foreach (var c in s) if (!char.IsLetterOrDigit(c) && c != '_') return false;
            return true;
        }

        // ── recursive descent ───────────────────────────────────────────
        // expr := term (('+'|'-') term)*
        private static MathExprNode ParseExpr(List<Tok> t, ref int p, string ctx)
        {
            var left = ParseTerm(t, ref p, ctx);
            while (p < t.Count && (t[p].Kind == TokKind.Plus || t[p].Kind == TokKind.Minus))
            {
                var op = t[p].Kind == TokKind.Plus ? '+' : '-'; p++;
                var right = ParseTerm(t, ref p, ctx);
                left = new BinaryNode { Op = op, Left = left, Right = right };
            }
            return left;
        }

        // term := factor (('*'|'/') factor)*
        private static MathExprNode ParseTerm(List<Tok> t, ref int p, string ctx)
        {
            var left = ParseFactor(t, ref p, ctx);
            while (p < t.Count && (t[p].Kind == TokKind.Star || t[p].Kind == TokKind.Slash))
            {
                var op = t[p].Kind == TokKind.Star ? '*' : '/'; p++;
                var right = ParseFactor(t, ref p, ctx);
                left = new BinaryNode { Op = op, Left = left, Right = right };
            }
            return left;
        }

        // factor := '-' factor | '(' expr ')' | number | ref | aggregate
        private static MathExprNode ParseFactor(List<Tok> t, ref int p, string ctx)
        {
            if (p >= t.Count) throw Err(ctx, "expression ended unexpectedly.");
            var tok = t[p];
            switch (tok.Kind)
            {
                case TokKind.Minus:
                    p++; return new UnaryNode { Operand = ParseFactor(t, ref p, ctx) };
                case TokKind.LParen:
                    p++;
                    var inner = ParseExpr(t, ref p, ctx);
                    if (p >= t.Count || t[p].Kind != TokKind.RParen) throw Err(ctx, "expression has an unbalanced '('.");
                    p++; return inner;
                case TokKind.Number:
                    p++; return new NumberNode { Value = tok.Num };
                case TokKind.Ref:
                    p++; return new ColumnRefNode { Node = tok.Node, Column = tok.Col };
                case TokKind.Agg:
                    p++; return new AggregateNode { Func = tok.Func, Node = tok.Node.Value, Column = tok.Col, FilterKey = tok.FilterKey };
                default:
                    throw Err(ctx, "expected a number, field, or '(' in expression.");
            }
        }

        private static InvalidPluginExecutionException Err(string ctx, string msg) =>
            new InvalidPluginExecutionException($"{ctx}: {msg}");
    }
}
