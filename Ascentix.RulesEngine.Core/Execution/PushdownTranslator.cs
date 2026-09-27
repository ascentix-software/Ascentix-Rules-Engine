using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

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

    /// <summary>A pushed date comparand that depends on one root's data: a date expression
    /// anchored on a field of the root or a single-cardinality lookup node. The plan (built once
    /// per bucket) carries it unbound; the executor binds it per root just before the fetch
    /// (<see cref="PushedFilter.Bind"/>).</summary>
    public sealed class DateBinding
    {
        public DateBinding(string payload, string op, DateColumnKind? kind = null, TimeZoneInfo zone = null,
            DateColumnKind? anchorKind = null)
        {
            Payload = payload;
            Operator = op;
            Kind = kind;
            Zone = zone;
            AnchorKind = anchorKind;
        }

        /// <summary>The criterion's dateexpr JSON (asx_value).</summary>
        public string Payload { get; }

        /// <summary>The criterion operator: picks the widening direction (unknown behavior) or the
        /// rounding direction of a fraction (known behavior).</summary>
        public string Operator { get; }

        /// <summary>The filtered column's behavior; null ⇒ widened UTC value.</summary>
        public DateColumnKind? Kind { get; }

        /// <summary>The rule's evaluation zone (part of the variant key: rules in different zones
        /// bind different values from the same payload).</summary>
        public TimeZoneInfo Zone { get; }

        /// <summary>The anchor column's behavior (null ⇒ unknown). Decided by the payload's anchor
        /// node and column, so it is the same for every root and needs no place in the key.</summary>
        public DateColumnKind? AnchorKind { get; }

        /// <summary>The pushed value for the bound anchor date; null when it cannot push. Read the
        /// way memory reads the same value (DateComparer.AsAnchor, then its round-trip "o"
        /// string): by the anchor column's behavior when known, a User Local anchor being an
        /// instant and a Date Only / TZI anchor a plain value. With the behavior unknown the
        /// DateTimeKind decides: UTC-kinded ("now", a User Local anchor) is an instant, unspecified
        /// is a plain value, and a local-kinded one carries an offset in memory, so it is an
        /// instant too. On a Date Only column the value is the calendar day, which
        /// <see cref="PushedFilter.Bind"/> pushes as a half-open day range.</summary>
        public string Format(DateTime value)
        {
            value = DateComparer.AsAnchor(value, AnchorKind);
            if (value.Kind == DateTimeKind.Local) value = value.ToUniversalTime();
            return PushedDateLiteral.Value(value, value.Kind == DateTimeKind.Utc, Operator, Kind, Zone);
        }
    }

    /// <summary>A translated condition, structured so goldens can assert without string-diffing.</summary>
    public class PushedCondition
    {
        public string Attribute { get; set; }
        public string Operator { get; set; }        // FetchXML operator token
        public string Value { get; set; }           // null for no-value operators
        public List<string> Values { get; set; }    // contain-values / not-contain-values

        /// <summary>Set on a date placeholder: <see cref="Value"/> stays null until bound.</summary>
        public DateBinding Binding { get; set; }
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
                if (c.Binding != null)
                    throw new InvalidOperationException(
                        $"Pushed filter on '{c.Attribute}' has an unbound date placeholder; bind it per root before serializing.");
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

        /// <summary>True when any condition (at any depth) is an unbound date placeholder.</summary>
        public bool HasBindings => Conditions.Any(c => c.Binding != null) || Children.Any(ch => ch.HasBindings);

        /// <summary>A copy with every placeholder bound to <paramref name="bind"/>'s value (see
        /// <see cref="DateBinding.Format"/>). A placeholder binds to its whole comparison fragment
        /// or not at all: one condition, or on a Date Only column its half-open day range
        /// (PushedDateLiteral.DayRange). A placeholder that binds to nothing has no bound for this
        /// root, so it relaxes to "no constraint": an AND group drops it (dropping a conjunct only
        /// widens), and an OR group containing it is itself unconstrained and drops out of its
        /// parent whole. Null when nothing constrained is left (the caller then fetches without a
        /// pushed filter); never an empty filter.</summary>
        public PushedFilter Bind(Func<DateBinding, string> bind)
        {
            var isOr = Op == LogicalOperator.Or;
            var bound = new PushedFilter { Op = Op };
            foreach (var c in Conditions)
            {
                if (c.Binding == null) { bound.Conditions.Add(c); continue; }
                var value = bind(c.Binding);
                var fragment = value == null ? null : PushedDateLiteral.Fragment(c.Attribute, c.Operator, value, c.Binding.Kind);
                if (fragment == null)
                {
                    if (isOr) return null;
                    continue;
                }
                bound.Merge(fragment);
            }
            foreach (var child in Children)
            {
                var boundChild = child.Bind(bind);
                if (boundChild == null)
                {
                    if (isOr) return null;
                    continue;
                }
                bound.Children.Add(boundChild);
            }
            return bound.IsEmpty ? null : bound;
        }

        /// <summary>Adds a complete fragment's members to this group: inline when the fragment
        /// has the same operator or a single member (the same predicate either way), otherwise as
        /// one child group.</summary>
        internal void Merge(PushedFilter fragment)
        {
            if (fragment.Op == Op || fragment.Conditions.Count + fragment.Children.Count == 1)
            {
                Conditions.AddRange(fragment.Conditions);
                Children.AddRange(fragment.Children);
            }
            else
            {
                Children.Add(fragment);
            }
        }

        private void AppendKey(StringBuilder sb)
        {
            sb.Append(Op == LogicalOperator.Or ? "or(" : "and(");
            foreach (var c in Conditions)
            {
                sb.Append("c[").Append(c.Attribute).Append('|').Append(c.Operator).Append('|');
                if (c.Binding != null) sb.Append('@').Append(c.Binding.Payload).Append('@').Append(c.Binding.Zone?.Id);
                else if (c.Values != null) sb.Append(string.Join(",", c.Values));
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
        private readonly DateTime? _utcNow;
        private readonly Func<Guid, bool> _canBindAnchor;
        private readonly Func<string, DateColumnKind?> _dateKindOf;
        private readonly TimeZoneInfo _zone;
        private readonly Func<Guid, string, DateColumnKind?> _anchorKindOf;

        /// <param name="resolveReference">FieldReference RHS resolver (null ⇒ all references refused).</param>
        /// <param name="isMultiSelectColumn">Per-column multi-select test on the FILTERED node's
        /// table (drives contain-values vs like translation; null ⇒ treat all as single-valued).</param>
        /// <param name="pushSubstringOperators">When false, like/contains/not-like/not-contains
        /// are refused (kept in memory). Callers without reliable per-column metadata MUST pass
        /// false: `contains` on a multi-select column means value-overlap, not text substring,
        /// and the wrong translation would narrow.</param>
        /// <param name="utcNow">The run's evaluation instant. When set, "now"-anchored
        /// DateExpression criteria push as literals; when null they stay in memory.</param>
        /// <param name="canBindAnchor">Whether a date expression anchored on this node may push as
        /// a per-root placeholder (see PushdownPlanner.CanBindAnchor). Null ⇒ anchored date
        /// expressions stay in memory.</param>
        /// <param name="dateKindOf">Date behavior of a column on the FILTERED node's table (null ⇒
        /// unknown: date values push widened, ranges only). When supplied, a column it answers
        /// null for is not a date column and takes no date path.</param>
        /// <param name="zone">The rule's evaluation time zone (null ⇒ UTC).</param>
        /// <param name="anchorKindOf">Date behavior of an anchor column (anchor node, column), so a
        /// placeholder reads its anchor the way memory does (DateBinding.AnchorKind). Null ⇒
        /// unknown: the anchor value's DateTimeKind decides.</param>
        public PushdownTranslator(
            TryResolveReferenceLiteral resolveReference = null,
            Func<string, bool> isMultiSelectColumn = null,
            bool pushSubstringOperators = true,
            DateTime? utcNow = null,
            Func<Guid, bool> canBindAnchor = null,
            Func<string, DateColumnKind?> dateKindOf = null,
            TimeZoneInfo zone = null,
            Func<Guid, string, DateColumnKind?> anchorKindOf = null)
        {
            _resolveReference = resolveReference;
            _isMultiSelectColumn = isMultiSelectColumn ?? (_ => false);
            _pushSubstringOperators = pushSubstringOperators;
            _utcNow = utcNow;
            _canBindAnchor = canBindAnchor;
            _dateKindOf = dateKindOf;
            _zone = zone;
            _anchorKindOf = anchorKindOf;
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
                // fragments (the OR-null widenings, Date Only day ranges) keep their own <filter> wrapper.
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

            var op = (c.Operator ?? string.Empty).Trim().ToLowerInvariant();

            // No-value operators need no RHS, whatever its source.
            if (op == "null") return Single(c.FieldName, "null");
            if (op == "not-null") return Single(c.FieldName, "not-null");

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
                case ComparisonValueSource.DateExpression:
                    return TranslateDateExpression(c, op);
                default:
                    return null; // Template RHS: not pushed
            }

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
            var isNumber = decimal.TryParse(literal, NumberStyles.Any, CultureInfo.InvariantCulture, out _);
            if (!isNumber && IsComparisonOperator(op) && PushedDateLiteral.TryParse(literal, out var date, out var isInstant))
                return TranslateDateLiteral(c.FieldName, op, date, isInstant);
            var exactLiteral = isNumber;

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

        private static bool IsComparisonOperator(string op) =>
            op == "eq" || op == "ne" || op == "gt" || op == "ge" || op == "lt" || op == "le";

        // With the column's behavior known, the literal pushes exactly, equality included (spec
        // §4.3; the value reads the literal the way DateComparer does; Date Only as a half-open day
        // range, see PushedDateLiteral.DayRange). A column metadata says is
        // not a date takes no date path: memory decides. With no metadata, ranges push a widened
        // UTC literal (PushedDateLiteral) and equality stays in memory: an exact date match
        // depends on the behavior (on a Date Only column the server compares calendar dates, on
        // User Local it reads an offset-less literal in the caller's time zone).
        private PushedFilter TranslateDateLiteral(string field, string op, DateTime value, bool isInstant)
        {
            DateColumnKind? kind = null;
            if (_dateKindOf != null)
            {
                kind = _dateKindOf(field);
                if (!kind.HasValue) return null;
            }
            return DateCondition(field, op, PushedDateLiteral.Fragment(field, op, value, isInstant, kind, _zone));
        }

        // `ne` gains the OR-null arm (SQL drops nulls from ne; memory keeps them). A Date Only `ne`
        // fragment is already an OR (lt D, ge D+1), so the arm joins it.
        private static PushedFilter DateCondition(string field, string op, PushedFilter fragment)
        {
            if (fragment == null || op != "ne") return fragment;
            var f = new PushedFilter { Op = LogicalOperator.Or };
            f.Merge(fragment);
            f.Conditions.Add(new PushedCondition { Attribute = field, Operator = "null" });
            return f;
        }

        // "Now" is one instant per run: it pushes as a value, exact for a known column behavior,
        // otherwise widened one day in the relaxing direction (earlier for gt/ge, later for lt/le),
        // a superset whatever the behavior; unknown-behavior eq/ne have no relaxing direction and
        // stay in memory. A field anchor on the root or a lookup pushes as a per-root placeholder.
        // Row anchors stay in memory, as does a column metadata says is not a date.
        private PushedFilter TranslateDateExpression(NodeFilterCriterion c, string op)
        {
            // Only eq/ne/gt/ge/lt/le compare dates: like/not-like would push without the
            // substring rules or the OR-null arm, and an unknown token is not FetchXML.
            if (!IsComparisonOperator(op)) return null;
            DateColumnKind? kind = null;
            if (_dateKindOf != null)
            {
                kind = _dateKindOf(c.FieldName);
                if (!kind.HasValue) return null;
            }
            if (!DateExprSpec.TryParse(c.Value, out var spec)) return null;
            if (spec.AnchorKind == "now")
            {
                if (!_utcNow.HasValue) return null;
                DateTime instant;
                // An amount that leaves the calendar: refuse the push. The in-memory filter reports
                // it; publish reports it as STRUCT_INVALID_DATEEXPR.
                try { instant = DateMath.Apply(_utcNow.Value, spec.Op, spec.Amount, spec.Unit); }
                catch (ArgumentOutOfRangeException) { return null; }
                return DateCondition(c.FieldName, op, PushedDateLiteral.Fragment(c.FieldName, op, instant, true, kind, _zone));
            }
            return AnchoredPlaceholder(c, op, spec, kind);
        }

        // A date expression anchored on a field of the root or a single-cardinality lookup has one
        // value per root, unknown when the plan is built: it pushes as a placeholder the executor
        // binds per root. Equality pushes only with a known column behavior (it has no relaxing
        // direction otherwise), and row anchors (no node) compare two columns of the same row, so
        // they stay in memory.
        private PushedFilter AnchoredPlaceholder(NodeFilterCriterion c, string op, DateExprSpec spec, DateColumnKind? kind)
        {
            if (_canBindAnchor == null || spec.AnchorKind != "field" || !spec.AnchorNode.HasValue) return null;
            var range = op == "gt" || op == "ge" || op == "lt" || op == "le";
            if (!range && !(kind.HasValue && (op == "eq" || op == "ne"))) return null;
            if (!_canBindAnchor(spec.AnchorNode.Value)) return null;

            var condition = new PushedCondition
            {
                Attribute = c.FieldName, Operator = op,
                Binding = new DateBinding(c.Value, op, kind, _zone, _anchorKindOf?.Invoke(spec.AnchorNode.Value, spec.AnchorColumn)),
            };
            if (op == "ne") return WidenWithNull(c.FieldName, condition);
            var f = new PushedFilter();
            f.Conditions.Add(condition);
            return f;
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
