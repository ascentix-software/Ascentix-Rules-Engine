using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Evaluation
{
    // ─── Node Filter Evaluator ────────────────────────────────────────────────

    /// <summary>
    /// Evaluates a NodeFilterGroup tree against a set of Entity records.
    /// Used by ConditionEvaluator.ApplyNodeFilters.
    /// </summary>
    public class NodeFilterEvaluator
    {
        private readonly IFieldValueResolver _resolver;
        private readonly ComparisonValueResolver _valueResolver;
        private readonly QueryResultCache _cache;
        private readonly TableConfigTree _tree;

        public NodeFilterEvaluator(IFieldValueResolver resolver) : this(resolver, null, null, null)
        {
        }

        public NodeFilterEvaluator(IFieldValueResolver resolver, ComparisonValueResolver valueResolver)
            : this(resolver, valueResolver, null, null)
        {
        }

        public NodeFilterEvaluator(
            IFieldValueResolver resolver,
            ComparisonValueResolver valueResolver,
            QueryResultCache cache,
            TableConfigTree tree)
        {
            _resolver = resolver;
            _valueResolver = valueResolver;
            _cache = cache;
            _tree = tree;
        }

        /// <summary>Back-compat overload for callers that never evaluate an Exists criterion
        /// (currentNodeId is only consulted by CriterionKind.Exists).</summary>
        public bool EvaluateFilterGroup(NodeFilterGroup filterGroup, List<Entity> records) =>
            EvaluateFilterGroup(filterGroup, records, Guid.Empty);

        public bool EvaluateFilterGroup(
            NodeFilterGroup filterGroup,
            List<Entity> records,
            Guid currentNodeId) =>
            EvaluateFilterGroup(filterGroup, records, currentNodeId, false);

        private bool EvaluateFilterGroup(
            NodeFilterGroup filterGroup,
            List<Entity> records,
            Guid currentNodeId,
            bool insideSubFilter)
        {
            var results = new List<bool>();

            foreach (var criterion in filterGroup.Criteria)
                results.Add(records.All(r => MatchesCriterion(r, criterion, currentNodeId, insideSubFilter)));

            foreach (var childGroup in filterGroup.ChildGroups)
                results.Add(EvaluateFilterGroup(childGroup, records, currentNodeId, insideSubFilter));

            if (!results.Any()) return true;

            return filterGroup.LogicalOperator switch
            {
                LogicalOperator.And => results.All(r => r),
                LogicalOperator.Or => results.Any(r => r),
                _ => throw new InvalidPluginExecutionException(
                    $"Unsupported LogicalOperator on node filter group {filterGroup.Id}")
            };
        }

        private bool MatchesCriterion(Entity record, NodeFilterCriterion criterion, Guid currentNodeId, bool insideSubFilter)
        {
            if (criterion.Kind == CriterionKind.Exists)
                return EvaluateExists(record, criterion, currentNodeId, insideSubFilter);

            if (string.IsNullOrWhiteSpace(criterion.Operator))
                throw new InvalidPluginExecutionException(
                    "Node filter criterion has no operator configured.");

            if (string.IsNullOrWhiteSpace(criterion.FieldName))
                throw new InvalidPluginExecutionException(
                    $"Node filter criterion (operator '{criterion.Operator}') has no column configured.");

            if (record.Contains(criterion.FieldName) &&
                record[criterion.FieldName] is OptionSetValueCollection)
                return EvaluateMultiSelectCriterion(record, criterion);

            var fieldValue = _resolver.ResolveFieldValue(record, criterion.FieldName);
            var rhs = ResolveRhs(record, criterion);

            switch (criterion.Operator)
            {
                case "eq": return ValueComparer.CompareScalar(fieldValue, ComparisonOperator.Equals, rhs);
                case "ne": return ValueComparer.CompareScalar(fieldValue, ComparisonOperator.NotEquals, rhs);
                case "gt": return ValueComparer.CompareScalar(fieldValue, ComparisonOperator.GreaterThan, rhs);
                case "ge": return ValueComparer.CompareScalar(fieldValue, ComparisonOperator.GreaterThanOrEqual, rhs);
                case "lt": return ValueComparer.CompareScalar(fieldValue, ComparisonOperator.LessThan, rhs);
                case "le": return ValueComparer.CompareScalar(fieldValue, ComparisonOperator.LessThanOrEqual, rhs);
                case "like": case "contains": return ValueComparer.CompareScalar(fieldValue, ComparisonOperator.Contains, rhs);
                case "not-like": case "not-contains": return ValueComparer.CompareScalar(fieldValue, ComparisonOperator.DoesNotContain, rhs);
                case "null": return ValueComparer.CompareScalar(fieldValue, ComparisonOperator.IsNull, rhs);
                case "not-null": return ValueComparer.CompareScalar(fieldValue, ComparisonOperator.IsNotNull, rhs);
                default: throw new InvalidPluginExecutionException($"Unsupported filter criterion operator: {criterion.Operator}");
            }
        }

        /// <summary>Evaluates a CriterionKind.Exists predicate: relates the current node and the
        /// target collection node via their config-tree common ancestor (TableConfigTree.Lca),
        /// walks `record` up to that ancestor's instance (NodeRelate.AncestorInstanceId), then
        /// counts cached collection rows under the same ancestor instance that also pass
        /// SubFilter, and compares the count against Min/MaxCount.</summary>
        private bool EvaluateExists(Entity record, NodeFilterCriterion c, Guid currentNodeId, bool insideSubFilter = false)
        {
            if (insideSubFilter)
                throw new InvalidPluginExecutionException(
                    "Exists criteria may only nest one level deep: an Exists sub-filter must contain " +
                    "field comparisons only. Re-save the rule in the editor to correct it.");

            if (!c.CollectionNodeId.HasValue)
                throw new InvalidPluginExecutionException(
                    "Exists criterion has no collection node configured; it cannot be evaluated.");

            // The collection must actually have been fetched. An EXISTS arm reads the node's
            // UNFILTERED cache entry, and Get() returns an empty list both when the fetch ran and
            // matched nothing AND when no fetch ran at all, so a node the planner failed to
            // demand counts zero here and the criterion reaches a confident, wrong answer (an
            // EXISTS min-1 fails, a max-0 passes) with nothing logged. Never guess from an
            // unfetched node.
            if (!_cache.Has(c.CollectionNodeId.Value))
                throw new InvalidPluginExecutionException(
                    $"Exists criterion reads collection node {c.CollectionNodeId.Value} " +
                    $"('{(_tree != null && _tree.TryGetNode(c.CollectionNodeId.Value, out var cn) ? cn.TableLogicalName : "?")}'), " +
                    "but no query was executed for it, so its rows are unknown. This is an engine " +
                    "planning fault, not a rule error: evaluating it would silently count zero.");

            var lca = _tree.Lca(currentNodeId, c.CollectionNodeId.Value);
            var rInstance = NodeRelate.AncestorInstanceId(record, currentNodeId, lca, _cache, _tree);
            int count = 0;
            if (rInstance.HasValue)
            {
                foreach (var row in _cache.Get(c.CollectionNodeId.Value))
                {
                    if (NodeRelate.AncestorInstanceId(row, c.CollectionNodeId.Value, lca, _cache, _tree) != rInstance) continue;
                    if (c.SubFilter == null || EvaluateFilterGroup(c.SubFilter,
                            new List<Entity> { row }, c.CollectionNodeId.Value, true))
                        count++;
                }
            }
            if (!c.MinCount.HasValue && !c.MaxCount.HasValue)
                return count >= 1; // unbounded means "at least one", not always-true

            return (!c.MinCount.HasValue || count >= c.MinCount.Value)
                && (!c.MaxCount.HasValue || count <= c.MaxCount.Value);
        }

        private string ResolveRhs(Entity record, NodeFilterCriterion criterion)
        {
            if (criterion.ValueSource != ComparisonValueSource.FieldReference)
                return criterion.Value;

            if (_valueResolver == null)
                throw new InvalidPluginExecutionException(
                    "Node filter criterion uses a FieldReference value source but no ComparisonValueResolver " +
                    "was supplied to the NodeFilterEvaluator.");

            return _valueResolver.ResolveNodeColumn(
                criterion.ComparisonValueNodeId, criterion.ComparisonValueColumn, record, "node filter");
        }

        private bool EvaluateMultiSelectCriterion(Entity record, NodeFilterCriterion criterion)
        {
            var collection = record[criterion.FieldName] as OptionSetValueCollection;

            if (criterion.Operator == "null") return collection == null || !collection.Any();
            if (criterion.Operator == "not-null") return collection != null && collection.Any();
            if (collection == null) return false;

            var actualValues = new HashSet<int>(collection.Select(o => o.Value));
            var configuredValues = ParseIntList(criterion.Value);

            return criterion.Operator switch
            {
                "eq" => configuredValues.Count == actualValues.Count &&
                                  configuredValues.All(v => actualValues.Contains(v)),
                "ne" => !(configuredValues.Count == actualValues.Count &&
                                   configuredValues.All(v => actualValues.Contains(v))),
                "contains" => configuredValues.Any(v => actualValues.Contains(v)),
                "not-contains" => !configuredValues.Any(v => actualValues.Contains(v)),
                _ => throw new InvalidPluginExecutionException(
                    $"Unsupported multi-select filter operator: {criterion.Operator}")
            };
        }

        private List<int> ParseIntList(string value) =>
            (value ?? string.Empty)
                .Split(',')
                .Select(v => v.Trim())
                .Where(v => int.TryParse(v, out _))
                .Select(int.Parse)
                .ToList();
    }
}
