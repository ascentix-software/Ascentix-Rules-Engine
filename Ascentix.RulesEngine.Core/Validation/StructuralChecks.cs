using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>Layer 1: required fields, empty groups, ≥1 condition + ≥1 action, regex compiles.</summary>
    public class StructuralChecks
    {
        private static readonly HashSet<ActionType> KnownActionTypes =
            new HashSet<ActionType>((ActionType[])Enum.GetValues(typeof(ActionType)));

        public IEnumerable<ValidationIssue> Check(RuleForValidation model)
        {
            var issues = new List<ValidationIssue>();

            if (!model.AllConditions().Any())
                issues.Add(ValidationIssue.Error("STRUCT_NO_CONDITIONS", "Rule has no conditions.", IssueTarget.Rule(model.RuleId)));

            var activeActions = model.Actions.Where(a => a.IsActive).ToList();
            if (activeActions.Count == 0)
                issues.Add(ValidationIssue.Error("STRUCT_NO_ACTIONS", "Rule has no active actions.", IssueTarget.Rule(model.RuleId)));

            CheckRowCountAtCreate(model, issues);

            foreach (var g in model.AllGroups())
            {
                var hasConditions = (g.Conditions?.Count ?? 0) > 0;
                var hasChildren = (g.ChildGroups?.Count ?? 0) > 0;
                if (!hasConditions && !hasChildren)
                    issues.Add(ValidationIssue.Error("STRUCT_EMPTY_GROUP", "Condition group is empty.", IssueTarget.Group(g.Id)));
            }

            foreach (var c in model.AllConditions())
                CheckCondition(c, model, issues);

            foreach (var a in activeActions)
                CheckAction(a, issues);

            foreach (var g in model.AllGroups())
                foreach (var nf in g.NodeFilterGroups ?? Enumerable.Empty<NodeFilterGroup>())
                    CheckFilterGroup(nf, IssueTarget.Rule(model.RuleId), issues, insideExistsSubFilter: false);

            foreach (var a in activeActions)
                CheckAggregateFilterStructure(a, issues);

            return issues;
        }

        // Shape checks for a node-filter criteria tree, shared by the condition-filter walk
        // (model.AllGroups() -> NodeFilterGroups) and the aggregate-filter walk
        // (CheckAggregateFilterStructure): an Exists criterion requires a CollectionNodeId; a
        // Comparison criterion must not carry Exists-only fields; and Exists criteria may only
        // nest one level deep (an Exists inside another Exists's SubFilter is rejected).
        // Recurses ChildGroups (AND/OR siblings) and, for Exists criteria, SubFilter (with
        // insideExistsSubFilter flipped to true) so arbitrarily deep trees are covered.
        private static void CheckFilterGroup(NodeFilterGroup group, IssueTarget target, List<ValidationIssue> issues, bool insideExistsSubFilter)
        {
            if (group == null) return;

            foreach (var crit in group.Criteria ?? Enumerable.Empty<NodeFilterCriterion>())
            {
                if (crit.Kind == CriterionKind.Exists)
                {
                    if (insideExistsSubFilter)
                        issues.Add(ValidationIssue.Error("STRUCT_NESTED_EXISTS",
                            "Exists criteria may only nest one level deep.", target));

                    if (!crit.CollectionNodeId.HasValue)
                        issues.Add(ValidationIssue.Error("STRUCT_MISSING_FIELD",
                            "Exists criterion requires a collection node.", target));

                    if (crit.SubFilter != null)
                        CheckFilterGroup(crit.SubFilter, target, issues, insideExistsSubFilter: true);
                }
                else if (crit.CollectionNodeId.HasValue || crit.MinCount.HasValue || crit.MaxCount.HasValue || crit.SubFilter != null)
                {
                    issues.Add(ValidationIssue.Error("STRUCT_COMPARISON_HAS_EXISTS_FIELDS",
                        "Comparison criterion must not set Exists-only fields (CollectionNodeId/MinCount/MaxCount/SubFilter).", target));
                }
                else
                {
                    // A comparison criterion with no column or no operator is not merely useless:
                    // NodeFilterEvaluator THROWS on it ("Node filter criterion has no operator
                    // configured." / "... has no column configured."), which surfaces to the user
                    // as a 400 that blocks the write. Without this check an auto-seeded blank
                    // filter row publishes a rule that validates clean and then fails every save
                    // on the table. The editor no longer persists incomplete leaves; this catches
                    // rules already stored that way as well as any other writer of the tables.
                    if (string.IsNullOrWhiteSpace(crit.FieldName))
                        issues.Add(ValidationIssue.Error("STRUCT_MISSING_FIELD",
                            "Filter comparison criterion requires a column.", target));

                    if (string.IsNullOrWhiteSpace(crit.Operator))
                        issues.Add(ValidationIssue.Error("STRUCT_MISSING_FIELD",
                            "Filter comparison criterion requires an operator.", target));
                }
            }

            foreach (var child in group.ChildGroups ?? Enumerable.Empty<NodeFilterGroup>())
                CheckFilterGroup(child, target, issues, insideExistsSubFilter);
        }

        // Aggregate filters (a mathexpr field-mapping entry's `filters` map) have no owning
        // NodeFilterGroup in the condition tree walked above, so they're re-parsed here the same
        // way MetadataChecks.CheckAggregateFilters does, and each filter's criteria tree is run
        // through the same CheckFilterGroup shared with the condition-filter walk.
        private static void CheckAggregateFilterStructure(RuleAction a, List<ValidationIssue> issues)
        {
            if ((a.ActionType != ActionType.CreateRecord && a.ActionType != ActionType.UpdateRecord)
                || string.IsNullOrWhiteSpace(a.FieldMapping)) return;

            List<FieldMappingEntry> entries;
            try { entries = FieldMappingParser.Parse(a.FieldMapping); }
            catch (InvalidPluginExecutionException) { return; } // already flagged by CheckFieldMapping above

            var target = IssueTarget.Action(a.Id, "FieldMapping");
            foreach (var entry in entries)
            {
                if (entry.Filters == null) continue;
                foreach (var kvp in entry.Filters)
                    CheckFilterGroup(kvp.Value, target, issues, insideExistsSubFilter: false);
            }
        }

        private static void CheckCondition(RuleCondition c, RuleForValidation model, List<ValidationIssue> issues)
        {
            void Missing(string field, string msg) =>
                issues.Add(ValidationIssue.Error("STRUCT_MISSING_FIELD", msg, IssueTarget.Condition(c.Id, field)));

            // Every condition evaluates against exactly one table-config node: ConditionEvaluator
            // resolves TableConfigNodeId against the rule's tree and throws
            // ("references table-config node ... which is not in the rule's config tree") when it
            // cannot. A condition saved with a null asx_tableconfig lookup arrives here as
            // Guid.Empty, so without this check validation passes a rule the engine then refuses
            // to run - and, once published, every write to the table fails.
            if (c.TableConfigNodeId == Guid.Empty)
                Missing("TableConfigNodeId", "Condition is not bound to a table-config node.");
            else if (!(model.Configs ?? TableConfigTree.Empty).Contains(c.TableConfigNodeId))
                issues.Add(ValidationIssue.Error("STRUCT_NODE_NOT_IN_TREE",
                    "Condition references a table-config node that is not in the rule's config tree.",
                    IssueTarget.Condition(c.Id, "TableConfigNodeId")));

            switch (c.ConditionType)
            {
                case ConditionType.FieldComparison:
                    if (string.IsNullOrWhiteSpace(c.ComparisonColumn)) Missing("ComparisonColumn", "Comparison column is required.");
                    if (c.ComparisonOperator == null) Missing("ComparisonOperator", "Comparison operator is required.");
                    var needsValue = c.ComparisonOperator != ComparisonOperator.IsNull
                                     && c.ComparisonOperator != ComparisonOperator.IsNotNull;
                    if (needsValue)
                    {
                        var valueBearingSource =
                            c.ValueSource == ComparisonValueSource.Literal ||
                            c.ValueSource == ComparisonValueSource.Template ||
                            c.ValueSource == ComparisonValueSource.DateExpression;
                        if (valueBearingSource && string.IsNullOrWhiteSpace(c.ComparisonValue))
                            Missing("ComparisonValue", "Comparison value is required.");
                        if (c.ValueSource == ComparisonValueSource.FieldReference && string.IsNullOrWhiteSpace(c.ComparisonValueColumn))
                            Missing("ComparisonValueColumn", "Field-reference column is required.");
                    }
                    break;

                case ConditionType.RowCount:
                    if (c.MinExpectedRows == null && c.MaxExpectedRows == null)
                        Missing("MinExpectedRows", "Row count needs a minimum or maximum.");
                    else if (c.MinExpectedRows.HasValue && c.MaxExpectedRows.HasValue && c.MinExpectedRows > c.MaxExpectedRows)
                        issues.Add(ValidationIssue.Error("STRUCT_ROWCOUNT_RANGE", "Minimum rows exceeds maximum rows.", IssueTarget.Condition(c.Id, "MinExpectedRows")));
                    else if (c.MinExpectedRows < 0 || c.MaxExpectedRows < 0)
                        issues.Add(ValidationIssue.Error("STRUCT_ROWCOUNT_NEGATIVE",
                            "Row count bounds cannot be negative.",
                            IssueTarget.Condition(c.Id, c.MinExpectedRows < 0 ? "MinExpectedRows" : "MaxExpectedRows")));
                    break;

                case ConditionType.RegexMatch:
                    if (string.IsNullOrWhiteSpace(c.ComparisonColumn)) Missing("ComparisonColumn", "Regex target column is required.");
                    if (string.IsNullOrWhiteSpace(c.ComparisonValue))
                        Missing("ComparisonValue", "Regex pattern is required.");
                    else
                    {
                        try { var _ = new Regex(c.ComparisonValue); }
                        catch (ArgumentException)
                        {
                            issues.Add(ValidationIssue.Error("STRUCT_INVALID_REGEX", "Regex pattern does not compile.", IssueTarget.Condition(c.Id, "ComparisonValue")));
                        }
                    }
                    break;

                case ConditionType.Expression:
                    if (string.IsNullOrWhiteSpace(c.Expression))
                    {
                        Missing("Expression", "Expression is required.");
                    }
                    else
                    {
                        try
                        {
                            var ast = MathExpr.Parse(c.Expression, "Expression");
                            if (MathExpr.AggregateNodes(ast).Any(a => !string.IsNullOrEmpty(a.FilterKey)))
                            {
                                // Aggregate filters (filter:<key>) resolve against a field-mapping's
                                // filters sidecar. Condition Expressions have no such map -
                                // ConditionEvaluator calls the no-filters TryEvaluate overload, so this
                                // would throw at runtime every time. Flag it here instead.
                                issues.Add(ValidationIssue.Error("STRUCT_EXPR_FILTER_UNSUPPORTED",
                                    "Aggregate filters (filter:<key>) are only supported in field mappings, not in condition expressions.",
                                    IssueTarget.Condition(c.Id, "Expression")));
                            }
                        }
                        catch (InvalidPluginExecutionException)
                        {
                            issues.Add(ValidationIssue.Error("STRUCT_INVALID_EXPRESSION", "Expression does not parse.", IssueTarget.Condition(c.Id, "Expression")));
                        }
                    }
                    if (c.ComparisonOperator == null) Missing("ComparisonOperator", "Comparison operator is required.");
                    break;
            }
        }

        private static void CheckAction(RuleAction a, List<ValidationIssue> issues)
        {
            void Missing(string field, string msg) =>
                issues.Add(ValidationIssue.Error("STRUCT_MISSING_FIELD", msg, IssueTarget.Action(a.Id, field)));

            if (!KnownActionTypes.Contains(a.ActionType))
            {
                issues.Add(ValidationIssue.Error("STRUCT_BAD_ACTIONTYPE", "Action type is missing or unknown.", IssueTarget.Action(a.Id, "ActionType")));
                return;
            }

            switch (a.ActionType)
            {
                case ActionType.SetVisible:
                case ActionType.SetRequired:
                    if (string.IsNullOrWhiteSpace(a.TargetColumn)) Missing("TargetColumn", "Target column is required.");
                    break;
                case ActionType.ShowMessage:
                case ActionType.Block:
                    if (string.IsNullOrWhiteSpace(a.Message)) Missing("Message", "Message is required.");
                    break;
                case ActionType.CreateRecord:
                    if (string.IsNullOrWhiteSpace(a.TargetTable)) Missing("TargetTable", "Target table is required.");
                    CheckFieldMapping(a, issues, requireMapping: true);
                    break;
                case ActionType.UpdateRecord:
                    if (a.TargetNodeId == null) Missing("TargetNodeId", "Target node is required.");
                    CheckFieldMapping(a, issues, requireMapping: true);
                    break;
                case ActionType.DeleteRecord:
                    if (a.TargetNodeId == null) Missing("TargetNodeId", "Target node is required.");
                    break;
            }
        }

        private static void CheckFieldMapping(RuleAction a, List<ValidationIssue> issues, bool requireMapping)
        {
            if (string.IsNullOrWhiteSpace(a.FieldMapping))
            {
                if (requireMapping)
                    issues.Add(ValidationIssue.Error("STRUCT_MISSING_FIELD", "Field mapping is required.", IssueTarget.Action(a.Id, "FieldMapping")));
                return;
            }
            try
            {
                var entries = FieldMappingParser.Parse(a.FieldMapping);
                if (requireMapping && entries.Count == 0)
                    issues.Add(ValidationIssue.Error("STRUCT_MISSING_FIELD", "Field mapping has no entries.", IssueTarget.Action(a.Id, "FieldMapping")));
            }
            catch (InvalidPluginExecutionException ex)
            {
                issues.Add(ValidationIssue.Error("STRUCT_MISSING_FIELD", "Field mapping is invalid: " + ex.Message, IssueTarget.Action(a.Id, "FieldMapping")));
            }
        }

        // At Create of the root record, Row Count evaluates the child rows existing at that
        // instant. A collection whose ancestor path
        // reaches the root through CHILD links only is structurally EMPTY then, so a
        // minimum-row condition can never pass and a Block(OnNoMatch) always blocks the create.
        // Deliberate, literal semantics (a skip-on-create carve-out would be a path where a
        // condition silently doesn't evaluate, the IsNull bug class reborn); this authoring
        // hint makes the consequence visible at publish time. Collections reached through a
        // LOOKUP hop are exempt: the looked-up record's children already exist at root-create.
        private static void CheckRowCountAtCreate(RuleForValidation model, List<ValidationIssue> issues)
        {
            var triggers = model.RuleEntity?.GetAttributeValue<OptionSetValueCollection>(
                Ascentix.RulesEngine.Schema.SchemaNames.Qualify(
                    Ascentix.RulesEngine.Schema.SchemaNames.Rule.Triggers));
            var hasOnCreate = triggers != null && triggers.Any(o => o != null && o.Value == (int)RuleTrigger.OnCreate);
            if (!hasOnCreate) return;

            foreach (var c in model.AllConditions())
            {
                if (c.ConditionType != ConditionType.RowCount) continue;
                if (!(c.MinExpectedRows > 0)) continue;
                if (!IsEmptyAtRootCreate(c.TableConfigNodeId, model)) continue;

                issues.Add(ValidationIssue.Warning(
                    "STRUCT_ROWCOUNT_ON_CREATE",
                    "This Row Count condition requires at least " + c.MinExpectedRows +
                    " related row(s), but at Create of the root record this collection is always " +
                    "empty: the condition can never pass during Create, so a Block (On No Match) " +
                    "will always block creates. Omit the On Create trigger if that is not intended.",
                    IssueTarget.Condition(c.Id)));
            }
        }

        // True when every hop from the node up to the root is a ChildTable link, the
        // structurally-empty-at-create class. Any LookupTable ancestor breaks the emptiness
        // argument; unknown/missing nodes and broken chains resolve false (TRAV_ checks own
        // those errors). No hop cap: the tree's walk is cycle-safe, so a chain of any depth is
        // answered structurally.
        private static bool IsEmptyAtRootCreate(Guid nodeId, RuleForValidation model)
            => (model.Configs ?? TableConfigTree.Empty).IsAllChildLinksToRoot(nodeId);
    }
}
