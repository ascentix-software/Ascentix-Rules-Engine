using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Evaluation
{
    // ─── Condition Evaluator ──────────────────────────────────────────────────

    /// <summary>
    /// Evaluates a single RuleCondition against cached query results.
    /// Applies node filters before evaluation.
    /// Returns a ConditionEvaluationResult with Passed status and FailedRecords.
    /// </summary>
    public class ConditionEvaluator
    {
        private readonly QueryResultCache _cache;
        private readonly TableConfigTree _tree;
        private readonly IFieldValueResolver _resolver;
        private readonly NodeFilterEvaluator _filterEvaluator;
        private readonly SearchCriteriaEvaluator _criteriaEvaluator;
        private readonly ComparisonValueResolver _valueResolver;

        public ConditionEvaluator(
            QueryResultCache cache,
            TableConfigTree tree,
            IFieldValueResolver resolver,
            IOptionLabelProvider labels = null,
            DateTime utcNow = default)
        {
            _cache = cache;
            _tree = tree ?? TableConfigTree.Empty;
            _resolver = resolver;
            _valueResolver = new ComparisonValueResolver(cache, _tree, resolver, labels, utcNow);
            _filterEvaluator = new NodeFilterEvaluator(resolver, _valueResolver, cache, _tree);
            _criteriaEvaluator = new SearchCriteriaEvaluator(resolver);
        }

        /// <summary>Optional pushdown decisions: which cache variant each condition reads.
        /// Null keeps every read on the unfiltered entries.</summary>
        public Ascentix.RulesEngine.Core.Execution.PushdownPlan Pushdown { get; set; }

        public ConditionEvaluationResult EvaluateCondition(
            RuleCondition condition,
            ConditionGroup conditionGroup,
            Entity root = null)
        {
            if (!_tree.TryGetNode(condition.TableConfigNodeId, out var node))
                throw new InvalidPluginExecutionException(
                    $"Condition {condition.Id} references table-config node {condition.TableConfigNodeId} which is not in the rule's config tree.");
            // Pushdown: a condition with a pushed variant reads the server-filtered rows
            // (a superset-returning relaxation); ApplyNodeFilters below re-runs the FULL original
            // filter over them, so partial pushdown stays exact. No variant ⇒ legacy unfiltered.
            var cachedResults =
                Pushdown != null && Pushdown.ConditionVariantKeys.TryGetValue(condition.Id, out var variantKey)
                    ? _cache.Get(node.Id, variantKey)
                    : _cache.Get(node.Id);
            var filteredResults = ApplyNodeFilters(cachedResults, node, conditionGroup, condition);

            return condition.ConditionType switch
            {
                ConditionType.FieldComparison =>
                    EvaluateFieldComparison(condition, filteredResults, node, root),
                ConditionType.RowCount =>
                    EvaluateRowCount(condition, filteredResults, node),
                ConditionType.RegexMatch =>
                    EvaluateRegexMatch(condition, filteredResults, node),
                ConditionType.Expression =>
                    EvaluateExpression(condition, root),
                _ => throw new InvalidPluginExecutionException(
                    $"Unsupported ConditionType: {condition.ConditionType}")
            };
        }

        // ── Evaluation Paths ─────────────────────────────────────────────────

        private ConditionEvaluationResult EvaluateFieldComparison(
            RuleCondition condition,
            List<Entity> records,
            TableConfig node,
            Entity root)
        {
            if (string.IsNullOrEmpty(condition.ComparisonColumn) ||
                condition.ComparisonOperator == null)
                return new ConditionEvaluationResult { Passed = true };

            var isChildNode = node.ConfigType == TableConfigType.ChildTable;
            var failedRecords = records
                .Where(r => !EvaluateComparison(r,
                    condition.ComparisonColumn,
                    condition.ComparisonOperator.Value,
                    _valueResolver.Resolve(condition, r, root)))
                .ToList();

            return new ConditionEvaluationResult
            {
                Passed = !failedRecords.Any(),
                FailedRecords = isChildNode
                    ? failedRecords
                    : failedRecords.Any() ? records : new List<Entity>()
            };
        }

        private ConditionEvaluationResult EvaluateRowCount(
            RuleCondition condition,
            List<Entity> records,
            TableConfig node)
        {
            if (node.ConfigType != TableConfigType.ChildTable)
                throw new InvalidPluginExecutionException(
                    $"RowCount condition {condition.Id} must reference a ChildTable node.");

            var parent = _tree.Parent(node.Id);
            if (parent == null)
                throw new InvalidPluginExecutionException(
                    $"RowCount condition {condition.Id}: child node '{node.TableLogicalName}' has no parent " +
                    "table configured; the row-count warning cannot be attached to a parent record.");

            var filtered = records
                .Where(r => _criteriaEvaluator.EvaluateCriteriaGroups(
                    condition.SearchCriteriaGroups, r))
                .ToList();

            var passed =
                (!condition.MinExpectedRows.HasValue || filtered.Count >= condition.MinExpectedRows.Value) &&
                (!condition.MaxExpectedRows.HasValue || filtered.Count <= condition.MaxExpectedRows.Value);

            // Warning points to nearest parent of the child node
            var parentResults = _cache.Get(parent.Id);

            return new ConditionEvaluationResult
            {
                Passed = passed,
                FailedRecords = passed ? new List<Entity>() : parentResults
            };
        }

        private ConditionEvaluationResult EvaluateRegexMatch(
            RuleCondition condition,
            List<Entity> records,
            TableConfig node)
        {
            if (string.IsNullOrEmpty(condition.ComparisonColumn))
                throw new InvalidPluginExecutionException(
                    $"ComparisonColumn is required for RegexMatch condition {condition.Id}");
            if (string.IsNullOrEmpty(condition.ComparisonValue))
                throw new InvalidPluginExecutionException(
                    $"ComparisonValue (the regex pattern) is required for RegexMatch condition {condition.Id}");

            Regex regex;
            try
            {
                // Compiled once per condition; the pattern is author-supplied.
                regex = new Regex(condition.ComparisonValue);
            }
            catch (ArgumentException ex)
            {
                throw new InvalidPluginExecutionException(
                    $"RegexMatch condition {condition.Id} has an invalid pattern: {ex.Message}");
            }

            var isChildNode = node.ConfigType == TableConfigType.ChildTable;
            var failedRecords = records
                .Where(r =>
                {
                    var value = _resolver.ResolveFieldValue(r, condition.ComparisonColumn) ?? string.Empty;
                    return !regex.IsMatch(value);
                })
                .ToList();

            return new ConditionEvaluationResult
            {
                Passed = !failedRecords.Any(),
                FailedRecords = isChildNode
                    ? failedRecords
                    : failedRecords.Any() ? records : new List<Entity>()
            };
        }

        private ConditionEvaluationResult EvaluateExpression(RuleCondition condition, Entity root)
        {
            // A null/blank expression has "no value" -> not satisfied, consistent with the
            // sibling seeding/collector guards (RootColumnCollector, field-mapping seeding).
            // Without this guard, MathExpr.Parse throws and aborts the whole run instead.
            if (string.IsNullOrWhiteSpace(condition.Expression))
                return new ConditionEvaluationResult
                {
                    Passed = false,
                    FailedRecords = new List<Entity> { root },
                };

            var ctx = $"condition {condition.Id}";
            var ast = Ascentix.RulesEngine.Core.Execution.MathExpr.Parse(condition.Expression, ctx);

            bool passed = false;
            if (Ascentix.RulesEngine.Core.Execution.MathExprEvaluator.TryEvaluate(
                    ast, root, _cache, _tree, ctx, out var lhs)
                && condition.ComparisonOperator.HasValue)
            {
                var rhsRaw = _valueResolver.Resolve(condition, root, root); // lhsRecord = root for same-record RHS
                if (decimal.TryParse(rhsRaw, System.Globalization.NumberStyles.Any,
                        System.Globalization.CultureInfo.InvariantCulture, out var rhs))
                    passed = CompareNumbers(lhs, condition.ComparisonOperator.Value, rhs);
            }
            // LHS "no value", RHS null/unparseable, or missing operator => not satisfied.

            return new ConditionEvaluationResult
            {
                Passed = passed,
                FailedRecords = passed ? new List<Entity>() : new List<Entity> { root },
            };
        }

        private static bool CompareNumbers(decimal a, ComparisonOperator op, decimal b)
        {
            switch (op)
            {
                case ComparisonOperator.Equals: return a == b;
                case ComparisonOperator.NotEquals: return a != b;
                case ComparisonOperator.GreaterThan: return a > b;
                case ComparisonOperator.GreaterThanOrEqual: return a >= b;
                case ComparisonOperator.LessThan: return a < b;
                case ComparisonOperator.LessThanOrEqual: return a <= b;
                default: return false; // non-numeric operator on an Expression condition = not satisfied
            }
        }

        // ── Comparison Logic ──────────────────────────────────────────────────

        private bool EvaluateComparison(
            Entity record,
            string column,
            ComparisonOperator op,
            string expectedValue)
        {
            // Live Dataverse omits a null column from the Entity entirely, so an ABSENT attribute
            // is the real-world representation of null. IsNull must match it; every other operator
            // (including IsNotNull) treats "no value present" as not-satisfied.
            if (!record.Contains(column)) return op == ComparisonOperator.IsNull;

            // Multi-select optionsets
            if (record[column] is OptionSetValueCollection)
                return EvaluateMultiSelectComparison(record, column, op, expectedValue);

            return ValueComparer.CompareScalar(_resolver.ResolveFieldValue(record, column), op, expectedValue);
        }

        private bool EvaluateMultiSelectComparison(
            Entity record,
            string column,
            ComparisonOperator op,
            string expectedValue)
        {
            var collection = record[column] as OptionSetValueCollection;

            if (op == ComparisonOperator.IsNull) return collection == null || !collection.Any();
            if (op == ComparisonOperator.IsNotNull) return collection != null && collection.Any();
            if (collection == null) return false;

            var actualValues = new HashSet<int>(collection.Select(o => o.Value));
            var configuredValues = (expectedValue ?? string.Empty)
                .Split(',')
                .Select(v => v.Trim())
                .Where(v => int.TryParse(v, out _))
                .Select(int.Parse)
                .ToList();

            return op switch
            {
                ComparisonOperator.Equals =>
                    configuredValues.Count == actualValues.Count &&
                    configuredValues.All(v => actualValues.Contains(v)),
                ComparisonOperator.NotEquals =>
                    !(configuredValues.Count == actualValues.Count &&
                      configuredValues.All(v => actualValues.Contains(v))),
                ComparisonOperator.Contains =>
                    configuredValues.Any(v => actualValues.Contains(v)),
                ComparisonOperator.DoesNotContain =>
                    !configuredValues.Any(v => actualValues.Contains(v)),
                _ => false  // fail-safe: unsupported operator for multi-select = no match (was: throw)
            };
        }

        // ── Node Filter Application ───────────────────────────────────────────

        /// <summary>
        /// Applies node filters scoped to the active condition group.
        /// Handles self-filters (targeting the condition's own node)
        /// and ancestor filters (cascading top-down through the ancestor chain).
        /// </summary>
        private List<Entity> ApplyNodeFilters(
            List<Entity> records,
            TableConfig node,
            ConditionGroup conditionGroup,
            RuleCondition condition)
        {
            // Scope to filters owned by this condition, plus legacy unowned (group-wide) filters.
            var owned = conditionGroup.NodeFilterGroups
                .Where(f => f.RuleConditionId == null || f.RuleConditionId == condition.Id)
                .ToList();
            if (!owned.Any()) return records;

            var filterTargetIds = new HashSet<Guid>(
                owned.Select(f => f.TableConfigNodeId));

            var ancestorChain = BuildAncestorChain(node);
            var hasAncestorFilters = ancestorChain.Any(a => filterTargetIds.Contains(a.Id));
            var hasSelfFilter = filterTargetIds.Contains(node.Id);

            if (!hasAncestorFilters && !hasSelfFilter)
                return records;

            var qualifyingIdsByNode = new Dictionary<Guid, HashSet<Guid>>();

            // Cascade ancestor filters top-down
            if (hasAncestorFilters)
            {
                foreach (var ancestor in ancestorChain)
                {
                    var filtersForAncestor = owned
                        .Where(f => f.TableConfigNodeId == ancestor.Id)
                        .ToList();

                    var cachedAncestorRecords = _cache.Get(ancestor.Id);
                    var qualifyingRecords = cachedAncestorRecords.AsEnumerable();

                    // Restrict by parent qualifying IDs if parent was filtered
                    if (ancestor.ParentTableId.HasValue &&
                        qualifyingIdsByNode.TryGetValue(ancestor.ParentTableId.Value, out var qualifyingParentIds))
                    {
                        qualifyingRecords = qualifyingRecords
                            .Where(r =>
                            {
                                var parentRef = r.GetAttributeValue<EntityReference>(ancestor.ChildLinkField);
                                return parentRef != null && qualifyingParentIds.Contains(parentRef.Id);
                            });
                    }

                    // Apply filters targeting this ancestor
                    if (filtersForAncestor.Any())
                    {
                        qualifyingRecords = qualifyingRecords
                            .Where(r => filtersForAncestor.All(f =>
                                _filterEvaluator.EvaluateFilterGroup(f, new List<Entity> { r }, ancestor.Id)));
                    }

                    qualifyingIdsByNode[ancestor.Id] = new HashSet<Guid>(
                        qualifyingRecords.Select(r => r.Id));
                }
            }

            // Apply to the condition's node records
            var result = records.AsEnumerable();

            // Restrict by qualifying parent IDs from ancestor cascade
            if (node.ParentTableId.HasValue &&
                qualifyingIdsByNode.TryGetValue(node.ParentTableId.Value, out var qualifyingIds))
            {
                result = result.Where(r =>
                {
                    var parentRef = r.GetAttributeValue<EntityReference>(node.ChildLinkField);
                    return parentRef != null && qualifyingIds.Contains(parentRef.Id);
                });
            }

            // Apply self-filters directly against this node's records
            if (hasSelfFilter)
            {
                var selfFilters = owned
                    .Where(f => f.TableConfigNodeId == node.Id)
                    .ToList();

                result = result.Where(r => selfFilters.All(f =>
                    _filterEvaluator.EvaluateFilterGroup(f, new List<Entity> { r }, node.Id)));
            }

            return result.ToList();
        }

        // Root → immediate parent (the node itself excluded). The tree validated the chain at
        // load, so the walk here carries no cycle/missing-parent guard of its own; on an
        // unvalidated tree a broken chain is reported rather than cascading over a partial one.
        private List<TableConfig> BuildAncestorChain(TableConfig node)
        {
            var diagnosis = _tree.ChainDiagnosis(node.Id);
            switch (diagnosis.Shape)
            {
                case ChainShape.MissingAncestor:
                    throw new InvalidPluginExecutionException(
                        $"Node filter on '{node.TableLogicalName}': ancestor node {diagnosis.MissingParentId} is missing " +
                        "from the rule's config tree; the rule cannot be evaluated.");
                case ChainShape.Cycle:
                    throw new InvalidPluginExecutionException(
                        $"Node filter on '{node.TableLogicalName}': the config tree has a cyclic parent " +
                        "chain; the rule cannot be evaluated.");
            }

            var chain = _tree.ChainToRoot(node.Id);
            return chain.Take(chain.Count - 1).ToList();
        }
    }
}
