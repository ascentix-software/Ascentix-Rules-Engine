using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Execution
{
    // ─── Filter Pushdown Translator ───────────────────────────────────────────
    //
    // Translates node-filter / search-criteria trees into FetchXML filter fragments so
    // Dataverse filters server-side and the engine only materializes matching rows (the
    // traversal cap counts RETURNED rows).
    //
    // SOUNDNESS CONTRACT (the partition rule): the pushed predicate must be a
    // superset-returning RELAXATION of the in-memory filter: it may return extra rows
    // (the full original filter is re-applied in memory afterwards, idempotently) but must
    // NEVER exclude a row the in-memory evaluation would keep. Concretely:
    //  - AND groups push any translatable subset (dropping a conjunct only widens).
    //  - OR groups push only when EVERY disjunct translates (pushing half an OR would narrow).
    //  - Negative operators (ne / not-like / not-contains) are widened with an OR-null arm:
    //    SQL three-valued logic excludes null rows from `ne`, while the in-memory evaluator
    //    may keep them. The widened form returns both, and memory decides.
    //  - like/contains: the in-memory semantic is a plain case-insensitive SUBSTRING test
    //    (SearchCriteriaEvaluator/NodeFilterEvaluator use IndexOf), so the pushed form is
    //    `like '%value%'` with SQL LIKE wildcard characters bracket-escaped ([ % _). The
    //    user's value is always treated as literal text, matching the in-memory meaning.
    //  - Anything else (Exists criteria, unresolved FieldReference RHS, multi-select
    //    exact-set ops) is refused: it stays in the in-memory residual, and the group that
    //    contains it is flagged so the TRAV_PUSHDOWN authoring warning can fire.

    /// <summary>Resolves a FieldReference RHS to a literal BEFORE the query builds (possible
    /// only for single-instance sources: root or lookup-chain nodes). False ⇒ not resolvable
    /// (multi-instance ancestor, missing node) and the criterion stays in memory.</summary>
    public delegate bool TryResolveReferenceLiteral(Guid? nodeId, string column, out string literal);

    /// <summary>A translated condition, structured so goldens can assert without string-diffing.</summary>
    public class PushedCondition
    {
        public string Attribute { get; set; }
        public string Operator { get; set; }        // FetchXML operator token
        public string Value { get; set; }           // null for no-value operators
        public List<string> Values { get; set; }    // contain-values / not-contain-values
    }

    /// <summary>A translated filter tree (maps 1:1 onto a FetchXML &lt;filter&gt; element).</summary>
    public class PushedFilter
    {
        public LogicalOperator Op { get; set; } = LogicalOperator.And;
        public List<PushedCondition> Conditions { get; } = new List<PushedCondition>();
        public List<PushedFilter> Children { get; } = new List<PushedFilter>();

        public bool IsEmpty => Conditions.Count == 0 && Children.Count == 0;

        /// <summary>Serializes to a FetchXML filter element with XML-escaped values.</summary>
        public string ToFetchXml()
        {
            var sb = new StringBuilder();
            AppendXml(sb);
            return sb.ToString();
        }

        private void AppendXml(StringBuilder sb)
        {
            sb.Append("<filter type='").Append(Op == LogicalOperator.Or ? "or" : "and").Append("'>");
            foreach (var c in Conditions)
            {
                sb.Append("<condition attribute='").Append(Esc(c.Attribute))
                  .Append("' operator='").Append(c.Operator).Append("'");
                if (c.Values != null)
                {
                    sb.Append(">");
                    foreach (var v in c.Values) sb.Append("<value>").Append(Esc(v)).Append("</value>");
                    sb.Append("</condition>");
                }
                else if (c.Value != null)
                {
                    sb.Append(" value='").Append(Esc(c.Value)).Append("' />");
                }
                else
                {
                    sb.Append(" />");
                }
            }
            foreach (var child in Children) child.AppendXml(sb);
            sb.Append("</filter>");
        }

        /// <summary>Deterministic key for cache-variant identity: same pushed predicate ⇒ same
        /// variant. Structural, order-preserving (criteria order is author-defined and stable).</summary>
        public string CanonicalKey()
        {
            var sb = new StringBuilder();
            AppendKey(sb);
            return sb.ToString();
        }

        private void AppendKey(StringBuilder sb)
        {
            sb.Append(Op == LogicalOperator.Or ? "or(" : "and(");
            foreach (var c in Conditions)
            {
                sb.Append("c[").Append(c.Attribute).Append('|').Append(c.Operator).Append('|');
                if (c.Values != null) sb.Append(string.Join(",", c.Values));
                else sb.Append(c.Value ?? "");
                sb.Append(']');
            }
            foreach (var child in Children) child.AppendKey(sb);
            sb.Append(')');
        }

        private static string Esc(string s) =>
            System.Security.SecurityElement.Escape(s ?? string.Empty);
    }

    /// <summary>The outcome of translating one filter tree.</summary>
    public class PushdownResult
    {
        /// <summary>The pushable relaxation; null when nothing could be pushed.</summary>
        public PushedFilter Pushed { get; set; }

        /// <summary>True when any criterion stayed in memory. Drives the TRAV_PUSHDOWN
        /// authoring warning and means the cap may count under-filtered rows.</summary>
        public bool HasResidual { get; set; }
    }

    public class PushdownTranslator
    {
        private readonly TryResolveReferenceLiteral _resolveReference;
        private readonly Func<string, bool> _isMultiSelectColumn;
        private readonly bool _pushSubstringOperators;

        /// <param name="resolveReference">FieldReference RHS resolver (null ⇒ all references refused).</param>
        /// <param name="isMultiSelectColumn">Per-column multi-select test on the FILTERED node's
        /// table (drives contain-values vs like translation; null ⇒ treat all as single-valued).</param>
        /// <param name="pushSubstringOperators">When false, like/contains/not-like/not-contains
        /// are refused (kept in memory). Callers without reliable per-column metadata MUST pass
        /// false: `contains` on a multi-select column means value-overlap, not text substring,
        /// and the wrong translation would narrow.</param>
        public PushdownTranslator(
            TryResolveReferenceLiteral resolveReference = null,
            Func<string, bool> isMultiSelectColumn = null,
            bool pushSubstringOperators = true)
        {
            _resolveReference = resolveReference;
            _isMultiSelectColumn = isMultiSelectColumn ?? (_ => false);
            _pushSubstringOperators = pushSubstringOperators;
        }

        public PushdownResult Translate(NodeFilterGroup group)
        {
            var result = new PushdownResult();
            if (group == null) return result;
            result.Pushed = TranslateGroup(group, result);
            if (result.Pushed != null && result.Pushed.IsEmpty) result.Pushed = null;
            return result;
        }

        /// <summary>Search-criteria overload (RowCount): criteria are literal-RHS by construction;
        /// the group's operator is carried by the owning search-criteria group.</summary>
        public PushdownResult Translate(IEnumerable<SearchCriterion> criteria, LogicalOperator op)
        {
            var group = new NodeFilterGroup { LogicalOperator = op };
            foreach (var c in criteria ?? Enumerable.Empty<SearchCriterion>())
                group.Criteria.Add(new NodeFilterCriterion
                {
                    Kind = CriterionKind.Comparison,
                    FieldName = c.FieldName,
                    Operator = c.Operator,
                    Value = c.Value,
                    ValueSource = ComparisonValueSource.Literal,
                });
            return Translate(group);
        }

        private PushedFilter TranslateGroup(NodeFilterGroup group, PushdownResult result)
        {
            var pushed = new PushedFilter { Op = group.LogicalOperator };
            var isOr = group.LogicalOperator == LogicalOperator.Or;
            var anyRefused = false;

            foreach (var criterion in group.Criteria ?? new List<NodeFilterCriterion>())
            {
                var translated = TranslateCriterion(criterion);
                if (translated == null) { anyRefused = true; continue; }
                // A single bare condition is operator-agnostic, so inline it. Multi-condition
                // fragments (the OR-null widenings) keep their own <filter> wrapper.
                if (translated.Conditions.Count == 1 && translated.Children.Count == 0)
                    pushed.Conditions.Add(translated.Conditions[0]);
                else
                    pushed.Children.Add(translated);
            }

            foreach (var child in group.ChildGroups ?? new List<NodeFilterGroup>())
            {
                var childResult = new PushdownResult();
                var childPushed = TranslateGroup(child, childResult);
                var childComplete = !childResult.HasResidual;
                if (childPushed != null && !childPushed.IsEmpty)
                {
                    if (isOr && !childComplete)
                    {
                        // A partially-pushed disjunct would narrow the OR, so refuse the child whole.
                        anyRefused = true;
                    }
                    else
                    {
                        pushed.Children.Add(childPushed);
                        if (!childComplete) result.HasResidual = true;
                    }
                }
                else
                {
                    anyRefused = true;
                }
            }

            if (anyRefused)
            {
                result.HasResidual = true;
                // All-or-nothing for OR: any refused disjunct makes the pushed subset a
                // narrowing, so nothing from this group may push.
                if (isOr) return null;
            }
            return pushed.IsEmpty ? null : pushed;
        }

        /// <summary>One criterion → a filter fragment (usually a single condition; negative
        /// operators become a two-arm OR with a null test). Null ⇒ refused (stays in memory).</summary>
        private PushedFilter TranslateCriterion(NodeFilterCriterion c)
        {
            if (c == null || c.Kind != CriterionKind.Comparison) return null;
            if (string.IsNullOrWhiteSpace(c.FieldName)) return null;

            string literal;
            switch (c.ValueSource)
            {
                case ComparisonValueSource.Literal:
                    literal = c.Value;
                    break;
                case ComparisonValueSource.FieldReference:
                    if (_resolveReference == null ||
                        !_resolveReference(c.ComparisonValueNodeId, c.ComparisonValueColumn, out literal))
                        return null;
                    break;
                default:
                    return null; // Template/DateExpression RHS: not pushed in phase 1
            }

            var op = (c.Operator ?? string.Empty).Trim().ToLowerInvariant();

            // No-value operators need no RHS at all.
            if (op == "null") return Single(c.FieldName, "null");
            if (op == "not-null") return Single(c.FieldName, "not-null");

            if (literal == null) return null; // valued operator without a value: leave in memory

            if (_isMultiSelectColumn(c.FieldName))
            {
                // Multi-select: only overlap tests push (exact-set eq/ne is phase 2).
                var values = literal.Split(',').Select(v => v.Trim()).Where(v => v.Length > 0).ToList();
                if (values.Count == 0) return null;
                switch (op)
                {
                    case "contains":
                        return Single(c.FieldName, "contain-values", values: values);
                    case "not-contains":
                        return WidenWithNull(c.FieldName,
                            new PushedCondition { Attribute = c.FieldName, Operator = "not-contain-values", Values = values });
                    default:
                        return null;
                }
            }

            // Collation soundness, verified against an accent-insensitive org:
            // server-side string comparison uses the org's collation (case/accent-insensitive),
            // the in-memory authority uses OrdinalIgnoreCase. For `eq` the server can only
            // return a SUPERSET of ordinal matches (case-fold ⊆ collation-fold), which is sound: the
            // re-application refines. For `ne` and range operators the server EXCLUDES rows the
            // authority would match ('Älpha' ne 'Alpha' is true ordinally, false under the
            // collation), a NARROWING no re-application can recover. Those operators therefore
            // push only with numeric/date literals (which compare collation-free server-side);
            // string-literal ne/ranges stay in memory until per-column metadata (phase 2) can
            // prove the column non-string.
            var exactLiteral =
                decimal.TryParse(literal, System.Globalization.NumberStyles.Any,
                    System.Globalization.CultureInfo.InvariantCulture, out _) ||
                DateTime.TryParse(literal, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.None, out _);

            switch (op)
            {
                case "eq": return Single(c.FieldName, "eq", literal);
                case "gt": return exactLiteral ? Single(c.FieldName, "gt", literal) : null;
                case "ge": return exactLiteral ? Single(c.FieldName, "ge", literal) : null;
                case "lt": return exactLiteral ? Single(c.FieldName, "lt", literal) : null;
                case "le": return exactLiteral ? Single(c.FieldName, "le", literal) : null;

                case "ne":
                    if (!exactLiteral) return null;
                    return WidenWithNull(c.FieldName,
                        new PushedCondition { Attribute = c.FieldName, Operator = "ne", Value = literal });

                // In-memory semantic is a literal SUBSTRING test: escape SQL LIKE wildcards so
                // the pushed pattern means the same thing.
                case "like":
                case "contains":
                    if (!_pushSubstringOperators) return null;
                    return Single(c.FieldName, "like", "%" + EscapeLikeValue(literal) + "%");

                case "not-like":
                case "not-contains":
                    if (!_pushSubstringOperators) return null;
                    return WidenWithNull(c.FieldName,
                        new PushedCondition { Attribute = c.FieldName, Operator = "not-like", Value = "%" + EscapeLikeValue(literal) + "%" });

                default:
                    return null; // unknown operator: never guess, leave in memory
            }
        }

        private static PushedFilter Single(string attribute, string op, string value = null, List<string> values = null)
        {
            var f = new PushedFilter();
            f.Conditions.Add(new PushedCondition { Attribute = attribute, Operator = op, Value = value, Values = values });
            return f;
        }

        /// <summary>Negative-operator widening: SQL three-valued logic drops null rows from
        /// ne/not-like; the widened (cond OR isnull) form returns them and lets the in-memory
        /// re-application decide, a pure relaxation either way.</summary>
        private static PushedFilter WidenWithNull(string attribute, PushedCondition condition)
        {
            var f = new PushedFilter { Op = LogicalOperator.Or };
            f.Conditions.Add(condition);
            f.Conditions.Add(new PushedCondition { Attribute = attribute, Operator = "null" });
            return f;
        }

        /// <summary>SQL LIKE bracket-escaping: [ opens a character class, % and _ are wildcards.
        /// Escaped, the user's value is always matched as literal text (the in-memory meaning).</summary>
        internal static string EscapeLikeValue(string value)
        {
            var sb = new StringBuilder(value.Length + 8);
            foreach (var ch in value)
            {
                switch (ch)
                {
                    case '[': sb.Append("[[]"); break;
                    case '%': sb.Append("[%]"); break;
                    case '_': sb.Append("[_]"); break;
                    default: sb.Append(ch); break;
                }
            }
            return sb.ToString();
        }
    }
}
