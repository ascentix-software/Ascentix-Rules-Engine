using System;
using System.Collections.Generic;
using System.Globalization;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Evaluation
{
    /// <summary>
    /// Resolves a condition's right-hand comparand: a literal, a same-record column, a
    /// column on a single-cardinality related node (root or a lookup-chain from root), a
    /// text template ({root.x}/{node:guid.x}), or a date expression (anchor + add/subtract
    /// interval, rendered as an ISO round-trip string so the existing date-aware comparison
    /// in ConditionEvaluator parses it). Aggregates and correlated 1:many parents are out of
    /// scope (Plan 2E phase 2). Template/DateExpression errors propagate (fail fast). See
    /// TemplateRenderer and DateExprEvaluator.
    /// </summary>
    public class ComparisonValueResolver
    {
        private readonly QueryResultCache _cache;
        private readonly TableConfigTree _tree;
        private readonly IFieldValueResolver _resolver;
        private readonly TemplateRenderer _templates;
        private readonly DateTime _utcNow;

        public ComparisonValueResolver(
            QueryResultCache cache,
            TableConfigTree tree,
            IFieldValueResolver resolver,
            IOptionLabelProvider labels = null,
            DateTime utcNow = default)
        {
            _cache = cache;
            _tree = tree ?? TableConfigTree.Empty;
            _resolver = resolver;
            _templates = new TemplateRenderer(_tree, labels);
            _utcNow = utcNow;
        }

        /// <summary>The comparand string for this condition against the given LHS record and the
        /// triggering root record (root/template/date-expression sources read against root).</summary>
        public string Resolve(RuleCondition condition, Entity lhsRecord, Entity root)
        {
            switch (condition.ValueSource)
            {
                case ComparisonValueSource.FieldReference:
                    return ResolveFieldReference(condition, lhsRecord);

                case ComparisonValueSource.Template:
                    return _templates.Render(condition.ComparisonValue, root, _cache, $"condition {condition.Id}");

                case ComparisonValueSource.DateExpression:
                    var spec = DateExprSpec.Parse(condition.ComparisonValue);
                    return DateExprEvaluator.Evaluate(spec, root, _cache, _tree, _resolver, _utcNow,
                            $"condition {condition.Id}")
                        .ToString("o", CultureInfo.InvariantCulture);

                default: // Literal
                    return condition.ComparisonValue;
            }
        }

        private string ResolveFieldReference(RuleCondition condition, Entity lhsRecord) =>
            ResolveNodeColumn(condition.ComparisonValueNodeId, condition.ComparisonValueColumn, lhsRecord,
                $"Condition {condition.Id}");

        /// <summary>Resolves a value-from-record RHS: a same-record column (valueNodeId == null) or a
        /// column on a single-cardinality node in the rule's config tree (root or a lookup chain).
        /// Shared by condition and node-filter-criterion RHS resolution.</summary>
        public string ResolveNodeColumn(Guid? valueNodeId, string valueColumn, Entity lhsRecord, string ctx)
        {
            // Same-record: read the column off the LHS record.
            if (!valueNodeId.HasValue)
                return _resolver.ResolveFieldValue(lhsRecord, valueColumn);

            // Cross-node: must be single-cardinality (no child hop on the path to root).
            var nodeId = valueNodeId.Value;
            if (!_tree.TryGetNode(nodeId, out var node))
                throw new InvalidPluginExecutionException(
                    $"{ctx}: comparison-value node {nodeId} is not in the rule's config tree.");

            // Prefix with no "node" (the tree's cardinality message already appends ": node '{...}'")
            // so the ChildTable message reads "{ctx}: comparison-value: node '{name}' is under a
            // 1:many (child) relationship; ...", preserving the comparison-value qualifier from
            // the pre-shared-helper wording without duplicating "node".
            _tree.RequireSingleCardinality(node.Id, $"{ctx}: comparison-value");

            var records = _cache.Get(nodeId);
            if (records.Count == 0) return null;
            if (records.Count > 1)
                throw new InvalidPluginExecutionException(
                    $"{ctx}: comparison-value node '{node.TableLogicalName}' resolved " +
                    $"{records.Count} records; a field reference must resolve to a single record.");

            return _resolver.ResolveFieldValue(records[0], valueColumn);
        }
    }
}
