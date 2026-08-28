using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Evaluation
{
    // ─── Search Criteria Evaluator ────────────────────────────────────────────

    /// <summary>
    /// Evaluates a SearchCriteriaGroup tree against a single Entity record.
    /// Used by ConditionEvaluator for RowCount in-memory filtering.
    /// </summary>
    public class SearchCriteriaEvaluator
    {
        private readonly IFieldValueResolver _resolver;

        public SearchCriteriaEvaluator(IFieldValueResolver resolver)
        {
            _resolver = resolver;
        }

        /// <summary>
        /// Root groups are always combined with AND.
        /// Returns true if no groups are configured (no filter = pass all).
        /// </summary>
        public bool EvaluateCriteriaGroups(
            List<SearchCriteriaGroup> groups,
            Entity record)
        {
            if (!groups.Any()) return true;
            return groups.All(g => EvaluateCriteriaGroup(g, record));
        }

        public bool EvaluateCriteriaGroup(
            SearchCriteriaGroup group,
            Entity record)
        {
            var results = new List<bool>();

            foreach (var criterion in group.Criteria)
                results.Add(MatchesCriterion(record, criterion));

            foreach (var childGroup in group.ChildGroups)
                results.Add(EvaluateCriteriaGroup(childGroup, record));

            if (!results.Any()) return true;

            return group.LogicalOperator switch
            {
                LogicalOperator.And => results.All(r => r),
                LogicalOperator.Or => results.Any(r => r),
                _ => throw new InvalidPluginExecutionException(
                    $"Unsupported LogicalOperator on search criteria group {group.Id}")
            };
        }

        private bool MatchesCriterion(Entity record, SearchCriterion criterion)
        {
            // Handle multi-select optionsets separately
            if (record.Contains(criterion.FieldName) &&
                record[criterion.FieldName] is OptionSetValueCollection)
                return EvaluateMultiSelectCriterion(record, criterion);

            var fieldValue = _resolver.ResolveFieldValue(record, criterion.FieldName);

            return criterion.Operator switch
            {
                "eq" => string.Equals(fieldValue, criterion.Value, StringComparison.OrdinalIgnoreCase),
                "ne" => !string.Equals(fieldValue, criterion.Value, StringComparison.OrdinalIgnoreCase),
                "like" => fieldValue?.IndexOf(criterion.Value, StringComparison.OrdinalIgnoreCase) >= 0,
                "not-like" => !(fieldValue?.IndexOf(criterion.Value, StringComparison.OrdinalIgnoreCase) >= 0),
                "null" => fieldValue == null,
                "not-null" => fieldValue != null,
                "contains" => fieldValue?.IndexOf(criterion.Value, StringComparison.OrdinalIgnoreCase) >= 0,
                "not-contains" => !(fieldValue?.IndexOf(criterion.Value, StringComparison.OrdinalIgnoreCase) >= 0),
                _ => throw new InvalidPluginExecutionException(
                    $"Unsupported search criterion operator: {criterion.Operator}")
            };
        }

        private bool EvaluateMultiSelectCriterion(Entity record, SearchCriterion criterion)
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
                    $"Unsupported multi-select operator: {criterion.Operator}")
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
