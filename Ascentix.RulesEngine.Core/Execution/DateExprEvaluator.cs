using System;
using System.Collections.Generic;
using System.Globalization;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>
    /// Resolves a <see cref="DateExprSpec"/> anchor (now, or a field on the root/a
    /// single-cardinality node) and applies <see cref="DateMath"/>. Two entry points share the
    /// anchor-node resolution but differ in how a field anchor's value is extracted AND in
    /// multi-record cardinality policy, matching each call site's existing (pre-refactor)
    /// semantics:
    /// <list type="bullet">
    /// <item><see cref="Evaluate"/>: condition RHS. Resolves the anchor field the same way
    /// FieldReference conditions do (<see cref="IFieldValueResolver"/>, i.e. formatted-string
    /// then parsed), so it round-trips consistently with the date-aware comparison already in
    /// ConditionEvaluator. A null/unparseable anchor field is a configuration error: throws.
    /// An anchor node resolving to more than one record also throws: strict, consistent with
    /// <see cref="Ascentix.RulesEngine.Core.Evaluation.ComparisonValueResolver"/>'s
    /// FieldReference single-cardinality guard.</item>
    /// <item><see cref="TryEvaluateFromRaw"/>: write side (asx_fieldmapping). Reads the anchor
    /// field's raw attribute value directly (no string round-trip, so DateTime.Kind/precision are
    /// preserved exactly). A null anchor field is not an error: returns false so the caller can
    /// skip writing that column, matching the write side's existing behavior. An anchor node
    /// resolving to more than one record silently takes the first record (no throw): the
    /// pre-refactor <c>WriteIntentResolver.ReadNodeValue</c> behavior, preserved as-is here.</item>
    /// </list>
    /// Every failure message is prefixed with the caller-supplied <c>errorContext</c> so
    /// condition-RHS errors carry the condition context and write-side errors regain the
    /// field-mapping/action context the pre-refactor code included.
    /// </summary>
    public static class DateExprEvaluator
    {
        /// <summary>Condition RHS: null/unparseable anchor field is a config error (fail fast);
        /// an anchor node resolving to &gt;1 record also throws (strict cardinality).</summary>
        public static DateTime Evaluate(DateExprSpec spec, Entity root, QueryResultCache cache,
            TableConfigTree tree, IFieldValueResolver resolver, DateTime utcNow,
            string errorContext)
        {
            var anchor = spec.AnchorKind == "now"
                ? utcNow
                : ResolveFieldAnchor(spec, root, cache, tree, resolver, errorContext);
            return DateMath.Apply(anchor, spec.Op, spec.Amount, spec.Unit);
        }

        /// <summary>Write side: preserves the existing null-anchor-field => skip-the-column
        /// behavior (returns false, does not throw). Still throws when the anchor field resolves
        /// to a non-null, non-date value (an author configuration error). An anchor node
        /// resolving to &gt;1 record silently takes the first record: lenient, matching the
        /// pre-refactor write-side behavior (no cardinality throw here).</summary>
        public static bool TryEvaluateFromRaw(DateExprSpec spec, Entity root, QueryResultCache cache,
            TableConfigTree tree, DateTime utcNow, string errorContext, out DateTime result)
        {
            if (spec.AnchorKind == "now")
            {
                result = DateMath.Apply(utcNow, spec.Op, spec.Amount, spec.Unit);
                return true;
            }

            var record = ResolveAnchorRecord(spec, root, cache, tree, strictCardinality: false, errorContext);
            var raw = ReadRaw(record, spec.AnchorColumn);
            if (raw is AliasedValue aliased) raw = aliased.Value;
            if (raw == null)
            {
                result = default;
                return false;
            }
            if (!(raw is DateTime dt))
                throw new InvalidPluginExecutionException(
                    $"{errorContext}: date expression anchor column '{spec.AnchorColumn}' did not resolve to a date value.");

            result = DateMath.Apply(dt, spec.Op, spec.Amount, spec.Unit);
            return true;
        }

        private static DateTime ResolveFieldAnchor(DateExprSpec spec, Entity root, QueryResultCache cache,
            TableConfigTree tree, IFieldValueResolver resolver, string errorContext)
        {
            var record = ResolveAnchorRecord(spec, root, cache, tree, strictCardinality: true, errorContext);
            var raw = record == null ? null : resolver.ResolveFieldValue(record, spec.AnchorColumn);
            if (string.IsNullOrEmpty(raw) ||
                !DateTime.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None, out var anchor))
                throw new InvalidPluginExecutionException(
                    $"{errorContext}: date expression anchor field '{spec.AnchorColumn}' is null or not a date.");
            return anchor;
        }

        /// <summary>Resolves the anchor node's cached record(s). <paramref name="strictCardinality"/>
        /// controls whether &gt;1 cached records throw (condition RHS, via <see cref="Evaluate"/>)
        /// or silently take the first record (write side, via <see cref="TryEvaluateFromRaw"/>, which
        /// preserves the pre-refactor <c>WriteIntentResolver.ReadNodeValue</c> behavior).</summary>
        private static Entity ResolveAnchorRecord(DateExprSpec spec, Entity root, QueryResultCache cache,
            TableConfigTree tree, bool strictCardinality, string errorContext)
        {
            if (!spec.AnchorNode.HasValue) return root;

            if (!tree.TryGetNode(spec.AnchorNode.Value, out var node))
                throw new InvalidPluginExecutionException(
                    $"{errorContext}: date expression anchor node {spec.AnchorNode} is not in the rule's config tree.");
            tree.RequireSingleCardinality(node.Id, errorContext);

            var records = cache.Get(node.Id);
            if (strictCardinality && records.Count > 1)
                throw new InvalidPluginExecutionException(
                    $"{errorContext}: date expression anchor node '{node.TableLogicalName}' resolved {records.Count} records; " +
                    "expected at most one.");
            return records.Count == 0 ? null : records[0];
        }

        private static object ReadRaw(Entity record, string column) =>
            record != null && !string.IsNullOrEmpty(column) && record.Contains(column) ? record[column] : null;
    }
}
