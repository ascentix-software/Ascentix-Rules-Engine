using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>Layer 3: columns/tables exist and are valid for their use; operator/type compatibility.</summary>
    public class MetadataChecks
    {

        public IEnumerable<ValidationIssue> Check(RuleForValidation model, IAttributeFlagsProvider metadata)
        {
            var issues = new List<ValidationIssue>();

            foreach (var c in model.AllConditions())
            {
                if (c.ConditionType == ConditionType.Expression)
                {
                    CheckExpressionCondition(c, model, issues);
                    continue;
                }

                if (c.ConditionType != ConditionType.FieldComparison && c.ConditionType != ConditionType.RegexMatch) continue;
                if (string.IsNullOrWhiteSpace(c.ComparisonColumn)) continue; // structural layer owns the missing-field error

                var table = TableForNode(model, c.TableConfigNodeId);
                if (table == null) continue; // traversal layer owns missing node

                var flags = metadata.GetFlags(table, c.ComparisonColumn);
                if (flags == null)
                {
                    issues.Add(ValidationIssue.Error("META_COLUMN_NOT_FOUND", $"Column '{c.ComparisonColumn}' does not exist on '{table}'.", IssueTarget.Condition(c.Id, "ComparisonColumn")));
                    continue;
                }
                if (!flags.IsValidForRead)
                    issues.Add(ValidationIssue.Error("META_COLUMN_NOT_READABLE", $"Column '{c.ComparisonColumn}' is not readable.", IssueTarget.Condition(c.Id, "ComparisonColumn")));
                if (c.ConditionType == ConditionType.FieldComparison && c.ComparisonOperator.HasValue
                    && !ComparisonOperatorSupport.IsAllowed(flags.Type, c.ComparisonOperator.Value))
                    issues.Add(ValidationIssue.Error("META_OPERATOR_TYPE_MISMATCH", $"Operator '{c.ComparisonOperator}' is not valid for column type '{flags.Type}'.", IssueTarget.Condition(c.Id, "ComparisonOperator")));
            }

            foreach (var a in model.Actions.Where(x => x.IsActive))
                CheckAction(model, a, metadata, issues);

            foreach (var col in model.TriggerColumns)
                if (!string.IsNullOrWhiteSpace(col) && metadata.GetFlags(model.PrimaryTable, col) == null)
                    issues.Add(ValidationIssue.Error("META_TRIGGER_COLUMN_NOT_FOUND",
                        $"Trigger column '{col}' does not exist on '{model.PrimaryTable}'.",
                        IssueTarget.Rule(model.RuleId)));

            foreach (var g in model.AllGroups())
                foreach (var nf in FlattenFilterGroups(g.NodeFilterGroups))
                    CheckFilterCriteria(nf, TableForNode(model, nf.TableConfigNodeId), metadata, model, IssueTarget.Rule(model.RuleId), issues);

            foreach (var a in model.Actions.Where(x => x.IsActive))
                CheckAggregateFilters(model, a, metadata, issues);

            return issues;
        }

        // The node-filter per-criterion checks (column exists, operator valid for the column's
        // type, FieldReference value-column exists), factored out so both the condition
        // node-filter loop (above) and the aggregate-filter loop (CheckAggregateFilters) share the
        // exact same logic instead of duplicating it.
        private static void CheckFilterCriteria(NodeFilterGroup group, string targetTable,
            IAttributeFlagsProvider metadata, RuleForValidation model, IssueTarget target, List<ValidationIssue> issues,
            bool skipExists = false)
        {
            foreach (var crit in group.Criteria)
            {
                if (crit.Kind == CriterionKind.Exists)
                {
                    // The aggregate-filter surface hoists Exists-criterion checks to run once per
                    // filter group (CheckAggregateFilterExistsCriteria) since they are table-independent;
                    // skipExists lets the per-aggregate-table loop there call this method for the
                    // table-dependent Comparison criteria only, without re-emitting Exists issues once
                    // per distinct table. The condition-filter surface never sets skipExists, since it
                    // already calls this method exactly once per group.
                    if (skipExists) continue;
                    CheckExistsFilterCriterion(crit, metadata, model, target, issues);
                    continue;
                }

                if (targetTable != null && !string.IsNullOrWhiteSpace(crit.FieldName))
                {
                    var flags = metadata.GetFlags(targetTable, crit.FieldName);
                    if (flags == null)
                        issues.Add(ValidationIssue.Error("META_FILTER_COLUMN_NOT_FOUND",
                            $"Filter column '{crit.FieldName}' does not exist on '{targetTable}'.", target));
                    else if (TryMapFilterOperator(crit.Operator, out var op)
                             && IsOrderingOperator(op)
                             && !ComparisonOperatorSupport.IsAllowed(flags.Type, op))
                        issues.Add(ValidationIssue.Error("META_FILTER_OPERATOR_TYPE_MISMATCH",
                            $"Filter operator '{crit.Operator}' is not valid for column type '{flags.Type}'.", target));
                }
                if (crit.ValueSource == ComparisonValueSource.FieldReference && crit.ComparisonValueNodeId.HasValue)
                {
                    var vt = TableForNode(model, crit.ComparisonValueNodeId.Value);
                    if (vt != null && !string.IsNullOrWhiteSpace(crit.ComparisonValueColumn)
                        && metadata.GetFlags(vt, crit.ComparisonValueColumn) == null)
                        issues.Add(ValidationIssue.Error("META_FILTER_VALUE_COLUMN_NOT_FOUND",
                            $"Filter value column '{crit.ComparisonValueColumn}' does not exist on '{vt}'.", target));
                }
            }
        }

        // An Exists criterion has no scalar column/operator of its own. Instead its SubFilter is
        // re-validated by the SAME shared checker (recursively, so scalar OR nested Exists criteria
        // inside the sub-filter are both handled), targeted at the COLLECTION node's table rather
        // than the outer group's table. The collection node's own existence/cardinality
        // (TRAV_NODE_NOT_FOUND / TRAV_EXISTS_NOT_COLLECTION) is TraversalChecks' concern, resolved
        // here only far enough to know which table to validate the sub-filter against (null when
        // the node is missing/invalid, which skips the column check the same way a missing
        // condition/aggregate node does elsewhere in this file).
        private static void CheckExistsFilterCriterion(NodeFilterCriterion crit, IAttributeFlagsProvider metadata,
            RuleForValidation model, IssueTarget target, List<ValidationIssue> issues)
        {
            string collectionTable = null;
            if (crit.CollectionNodeId.HasValue && model.Configs.TryGetNode(crit.CollectionNodeId.Value, out var node)
                && node.ConfigType == TableConfigType.ChildTable)
                collectionTable = node.TableLogicalName;

            if (crit.SubFilter != null)
                foreach (var flat in FlattenFilterGroups(new[] { crit.SubFilter }))
                    CheckFilterCriteria(flat, collectionTable, metadata, model, target, issues);

            var negativeMin = crit.MinCount.HasValue && crit.MinCount.Value < 0;
            var negativeMax = crit.MaxCount.HasValue && crit.MaxCount.Value < 0;
            var inverted = crit.MinCount.HasValue && crit.MaxCount.HasValue && crit.MinCount.Value > crit.MaxCount.Value;
            if (negativeMin || negativeMax || inverted)
                issues.Add(ValidationIssue.Error("META_EXISTS_COUNT_RANGE",
                    "Exists MinCount/MaxCount must be non-negative, and MinCount must not exceed MaxCount.", target));
        }

        // Aggregate filters (a mathexpr field-mapping entry's `filters` map, keyed by an
        // aggregate's `filter:<key>` token) have no TraversalChecks-equivalent walk (they live
        // inside FieldMapping rather than a ConditionGroup's NodeFilterGroups), so this method
        // both reuses CheckFilterCriteria (column/operator/value-column) against the owning
        // aggregate's node table AND checks FieldReference value-node cardinality itself
        // (reusing the TRAV_NOT_SINGLE_CARDINALITY code for consistency with the condition-filter
        // equivalent in TraversalChecks). Key integrity (every filter:<key> has exactly one
        // matching `filters` entry) is enforced by FieldMappingParser.Parse at parse time; a
        // mismatch throws and is caught here (and by CheckMappingColumns/TraversalChecks) so it
        // surfaces once, as a structural issue, rather than aborting validation.
        private void CheckAggregateFilters(RuleForValidation model, RuleAction a, IAttributeFlagsProvider metadata, List<ValidationIssue> issues)
        {
            if (a.ActionType != ActionType.CreateRecord && a.ActionType != ActionType.UpdateRecord) return;
            if (string.IsNullOrWhiteSpace(a.FieldMapping)) return;

            List<FieldMappingEntry> entries;
            try { entries = FieldMappingParser.Parse(a.FieldMapping); }
            catch (InvalidPluginExecutionException) { return; } // structural layer owns malformed mapping / filter-key integrity

            var target = IssueTarget.Action(a.Id, "FieldMapping");
            foreach (var entry in entries)
            {
                if (entry.Source != "mathexpr" || string.IsNullOrWhiteSpace(entry.Expression)
                    || entry.Filters == null || entry.Filters.Count == 0) continue;

                MathExprNode ast;
                try { ast = MathExpr.Parse(entry.Expression, $"asx_fieldmapping mathexpr for target '{entry.Target}'"); }
                catch (InvalidPluginExecutionException) { continue; } // structural layer owns the parse error

                var aggregatesByKey = MathExpr.AggregateNodes(ast)
                    .Where(ag => ag.FilterKey != null)
                    .GroupBy(ag => ag.FilterKey)
                    .ToDictionary(g => g.Key, g => g.ToList());

                foreach (var kvp in entry.Filters)
                {
                    // Orphan/missing filter keys are already rejected by FieldMappingParser.Parse
                    // (caught above); this guard is defensive only.
                    if (!aggregatesByKey.TryGetValue(kvp.Key, out var aggs)) continue;

                    var flatGroups = FlattenFilterGroups(new[] { kvp.Value }).ToList();

                    // Value-node cardinality, Exists collection-node validity, and Exists-criterion
                    // checks (count-range + recursive sub-filter, via CheckAggregateFilterExistsCriteria)
                    // depend only on the filter group + model, not on which aggregate/table is being
                    // checked, so run them once per filter key, not once per distinct table, or a filter
                    // key shared across aggregates on different tables would emit the same issue once
                    // per table.
                    foreach (var flatGroup in flatGroups)
                    {
                        CheckAggregateFilterValueNodeCardinality(model, flatGroup, target, issues);
                        CheckAggregateFilterExistsCollectionNodes(model, flatGroup, target, issues);
                        CheckAggregateFilterExistsCriteria(model, flatGroup, metadata, target, issues);
                    }

                    // A single filter key may be shared by multiple aggregates (e.g.
                    // sum(node:A.col filter:f1) + sum(node:B.col filter:f1)). At eval time the
                    // same filter group is applied independently to each aggregate's node rows,
                    // so every referencing aggregate's node table must be validated, not just
                    // the first. Dedupe by (table, filter-group) so the common single-aggregate
                    // case doesn't produce duplicate issues. CheckFilterCriteria's Comparison-criteria
                    // checks ARE table-dependent (checks columns/operators against aggTable), so they
                    // stay in this loop; skipExists suppresses its Exists handling, which was hoisted
                    // above.
                    var checkedTables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var agg in aggs)
                    {
                        var aggTable = TableForNode(model, agg.Node);
                        if (aggTable == null) continue; // traversal layer owns a missing/invalid aggregate node
                        if (!checkedTables.Add(aggTable)) continue; // already validated this table for this filter

                        foreach (var flatGroup in flatGroups)
                        {
                            CheckFilterCriteria(flatGroup, aggTable, metadata, model, target, issues, skipExists: true);
                        }
                    }
                }
            }
        }

        // Aggregate-filter equivalent of TraversalChecks' own condition-filter Exists collection-node
        // walk. Reuses TraversalChecks.CheckExistsCollectionNode (rather than reimplementing the
        // existence/ChildTable check here) since the aggregate-filter loop has no TraversalChecks
        // walk of its own (see CheckAggregateFilterValueNodeCardinality above for the same pattern).
        private static void CheckAggregateFilterExistsCollectionNodes(RuleForValidation model, NodeFilterGroup group, IssueTarget target, List<ValidationIssue> issues)
        {
            foreach (var crit in group.Criteria)
                if (crit.Kind == CriterionKind.Exists)
                    TraversalChecks.CheckExistsCollectionNode(model.Configs, crit.CollectionNodeId, target, issues);
        }

        // Exists-criterion checks (count-range + recursive sub-filter validation via
        // CheckExistsFilterCriterion) are table-independent (they depend only on the criterion and
        // its collection node, not on which aggregate/table is being checked), so they run once per
        // filter group here, mirroring CheckAggregateFilterExistsCollectionNodes above. The
        // per-aggregate-table loop in CheckAggregateFilters calls CheckFilterCriteria with
        // skipExists:true so these aren't re-emitted once per distinct table sharing this filter key.
        private static void CheckAggregateFilterExistsCriteria(RuleForValidation model, NodeFilterGroup group,
            IAttributeFlagsProvider metadata, IssueTarget target, List<ValidationIssue> issues)
        {
            foreach (var crit in group.Criteria)
                if (crit.Kind == CriterionKind.Exists)
                    CheckExistsFilterCriterion(crit, metadata, model, target, issues);
        }

        private static void CheckAggregateFilterValueNodeCardinality(RuleForValidation model, NodeFilterGroup group, IssueTarget target, List<ValidationIssue> issues)
        {
            foreach (var crit in group.Criteria)
            {
                if (crit.ValueSource != ComparisonValueSource.FieldReference || !crit.ComparisonValueNodeId.HasValue) continue;
                if (!model.Configs.Contains(crit.ComparisonValueNodeId.Value)) continue; // traversal layer owns a missing node

                // The non-throwing façade (not RequireSingleCardinality): this sweep collects every
                // issue and must never abort on a broken parent chain.
                if (!model.Configs.TrySingleCardinality(crit.ComparisonValueNodeId.Value))
                    issues.Add(ValidationIssue.Error("TRAV_NOT_SINGLE_CARDINALITY",
                        "Aggregate filter value-reference must target a single-cardinality node.", target));
            }
        }

        // Depth-first flatten of a node-filter group tree (root filter groups + all nested child groups).
        private static IEnumerable<NodeFilterGroup> FlattenFilterGroups(IEnumerable<NodeFilterGroup> groups)
        {
            foreach (var g in groups ?? Enumerable.Empty<NodeFilterGroup>())
            {
                yield return g;
                foreach (var child in FlattenFilterGroups(g.ChildGroups))
                    yield return child;
            }
        }

        // Maps a filter criterion's operator token to the ComparisonOperator enum. Returns false
        // for null/not-null/unknown tokens, which have no type-compatibility notion and therefore
        // skip the operator/type check entirely.
        private static bool TryMapFilterOperator(string token, out ComparisonOperator op)
        {
            switch (token)
            {
                case "eq": op = ComparisonOperator.Equals; return true;
                case "ne": op = ComparisonOperator.NotEquals; return true;
                case "gt": op = ComparisonOperator.GreaterThan; return true;
                case "ge": op = ComparisonOperator.GreaterThanOrEqual; return true;
                case "lt": op = ComparisonOperator.LessThan; return true;
                case "le": op = ComparisonOperator.LessThanOrEqual; return true;
                case "like": case "contains": op = ComparisonOperator.Contains; return true;
                case "not-like": case "not-contains": op = ComparisonOperator.DoesNotContain; return true;
                default: op = default(ComparisonOperator); return false; // null / not-null / unknown
            }
        }

        // Only the ordering operators can be type-invalid for a column (e.g. gt on a string);
        // equality/contains/null-checks are meaningful (or harmlessly coerced) across all types.
        private static bool IsOrderingOperator(ComparisonOperator op)
            => op == ComparisonOperator.GreaterThan || op == ComparisonOperator.GreaterThanOrEqual
               || op == ComparisonOperator.LessThan || op == ComparisonOperator.LessThanOrEqual;

        private void CheckAction(RuleForValidation model, RuleAction a, IAttributeFlagsProvider metadata, List<ValidationIssue> issues)
        {
            switch (a.ActionType)
            {
                case ActionType.SetVisible:
                case ActionType.SetRequired:
                    if (!string.IsNullOrWhiteSpace(a.TargetColumn) && metadata.GetFlags(model.PrimaryTable, a.TargetColumn) == null)
                        issues.Add(ValidationIssue.Error("META_COLUMN_NOT_FOUND", $"Column '{a.TargetColumn}' does not exist on '{model.PrimaryTable}'.", IssueTarget.Action(a.Id, "TargetColumn")));
                    break;

                case ActionType.CreateRecord:
                    if (!string.IsNullOrWhiteSpace(a.TargetTable))
                    {
                        if (!metadata.TableExists(a.TargetTable))
                            issues.Add(ValidationIssue.Error("META_TABLE_NOT_FOUND", $"Target table '{a.TargetTable}' does not exist.", IssueTarget.Action(a.Id, "TargetTable")));
                        else
                            CheckMappingColumns(a, a.TargetTable, metadata, issues, requireCreatable: true);
                    }
                    break;

                case ActionType.UpdateRecord:
                    var updTable = a.TargetNodeId.HasValue ? TableForNode(model, a.TargetNodeId.Value) : null;
                    if (updTable != null) // traversal layer owns a missing/invalid node
                        CheckMappingColumns(a, updTable, metadata, issues, requireCreatable: false);
                    break;
            }
        }

        private void CheckMappingColumns(RuleAction a, string table, IAttributeFlagsProvider metadata, List<ValidationIssue> issues, bool requireCreatable)
        {
            List<FieldMappingEntry> entries;
            try { entries = FieldMappingParser.Parse(a.FieldMapping); }
            catch (InvalidPluginExecutionException) { return; } // structural layer owns malformed mapping

            foreach (var entry in entries)
            {
                if (string.IsNullOrWhiteSpace(entry.Target)) continue;
                var flags = metadata.GetFlags(table, entry.Target);
                if (flags == null)
                {
                    issues.Add(ValidationIssue.Error("META_COLUMN_NOT_FOUND", $"Mapping column '{entry.Target}' does not exist on '{table}'.", IssueTarget.Action(a.Id, "FieldMapping")));
                    continue;
                }
                if (requireCreatable && !flags.IsValidForCreate)
                    issues.Add(ValidationIssue.Error("META_COLUMN_NOT_CREATABLE", $"Column '{entry.Target}' is not creatable.", IssueTarget.Action(a.Id, "FieldMapping")));
                if (!requireCreatable && !flags.IsValidForUpdate)
                    issues.Add(ValidationIssue.Error("META_COLUMN_NOT_UPDATABLE", $"Column '{entry.Target}' is not updatable.", IssueTarget.Action(a.Id, "FieldMapping")));
            }
        }

        // Expression condition: LHS is a mathexpr, not a stored column, so the operator/type
        // check is keyed by ComparisonOperatorSupport.ForExpression (numeric only) instead of
        // an AttributeTypeCode. Each aggregate node referenced by the expression must be a
        // many-cardinality (child) collection. An aggregate over a single-cardinality node is
        // an author error (mirrors TableConfigTree.RequireSingleCardinality, the engine's runtime guard).
        private void CheckExpressionCondition(RuleCondition c, RuleForValidation model, List<ValidationIssue> issues)
        {
            if (c.ComparisonOperator.HasValue && !ComparisonOperatorSupport.IsAllowedForExpression(c.ComparisonOperator.Value))
                issues.Add(ValidationIssue.Error("META_OPERATOR_TYPE_MISMATCH",
                    $"Operator '{c.ComparisonOperator}' is not valid for an Expression condition (numeric operators only).",
                    IssueTarget.Condition(c.Id, "ComparisonOperator")));

            if (string.IsNullOrWhiteSpace(c.Expression)) return; // structural layer owns the missing-expression error

            MathExprNode ast;
            try { ast = MathExpr.Parse(c.Expression, "Expression"); }
            catch (InvalidPluginExecutionException) { return; } // structural layer owns the parse error

            foreach (var agg in ExtractAggregateNodes(ast))
            {
                if (!model.Configs.TryGetNode(agg.Node, out var node)) continue; // unknown node, not this layer's concern
                // A valid aggregate target is exactly "the chain reaches the root AND a ChildTable
                // lies on it". The diagnosis keeps the two ways a node can fail that apart: a
                // single-cardinality chain (Ok, no child) and a malformed one (cycle / missing
                // ancestor / parentless non-root). Both are flagged: a malformed shape is not
                // a collection either, and MathExprEvaluator would throw on it at runtime.
                var chain = model.Configs.ChainDiagnosis(agg.Node);
                if (!chain.IsOk || !chain.ChildOnPath)
                    issues.Add(ValidationIssue.Error("META_AGGREGATE_NOT_COLLECTION",
                        $"Aggregate targets node '{node.TableLogicalName}' which is not a many-cardinality (child) collection.",
                        IssueTarget.Condition(c.Id, "Expression")));
            }
        }

        private static IEnumerable<AggregateNode> ExtractAggregateNodes(MathExprNode ast)
        {
            switch (ast)
            {
                case AggregateNode a:
                    yield return a;
                    break;
                case UnaryNode u:
                    foreach (var r in ExtractAggregateNodes(u.Operand)) yield return r;
                    break;
                case BinaryNode b:
                    foreach (var r in ExtractAggregateNodes(b.Left)) yield return r;
                    foreach (var r in ExtractAggregateNodes(b.Right)) yield return r;
                    break;
            }
        }

        private static string TableForNode(RuleForValidation model, Guid nodeId)
            => model.Configs.TryGetNode(nodeId, out var cfg) ? cfg.TableLogicalName : null;
    }
}
