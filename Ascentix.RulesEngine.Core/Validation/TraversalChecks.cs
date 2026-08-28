using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>Layer 2: referenced nodes exist + are reachable; write/field-ref targets are single-cardinality.
    /// Reads the rule's UNVALIDATED <see cref="TableConfigTree"/>: every query used here answers
    /// conservatively on a broken shape (cycle / missing ancestor / parentless non-root):
    /// <see cref="TableConfigTree.TrySingleCardinality"/> false, <see cref="TableConfigTree.IsReachableFromRoot"/>
    /// false, so a malformed chain surfaces as an issue rather than a throw.</summary>
    public class TraversalChecks
    {
        public IEnumerable<ValidationIssue> Check(RuleForValidation model)
        {
            var issues = new List<ValidationIssue>();
            var tree = model.Configs ?? TableConfigTree.Empty;

            foreach (var c in model.AllConditions())
            {
                if (c.ValueSource == ComparisonValueSource.FieldReference && c.ComparisonValueNodeId.HasValue)
                {
                    var nodeId = c.ComparisonValueNodeId.Value;
                    if (!tree.Contains(nodeId))
                        issues.Add(ValidationIssue.Error("TRAV_NODE_NOT_FOUND", "Field-reference node does not exist in the configuration.", IssueTarget.Condition(c.Id, "ComparisonValueNodeId")));
                    else if (!tree.TrySingleCardinality(nodeId))
                        issues.Add(ValidationIssue.Error("TRAV_NOT_SINGLE_CARDINALITY", "Field-reference must target a single-cardinality node.", IssueTarget.Condition(c.Id, "ComparisonValueNodeId")));
                    else if (!tree.IsReachableFromRoot(nodeId))
                        issues.Add(ValidationIssue.Error("TRAV_NODE_UNREACHABLE", "Field-reference node is not reachable from the root.", IssueTarget.Condition(c.Id, "ComparisonValueNodeId")));
                }
            }

            foreach (var a in model.Actions.Where(x => x.IsActive))
            {
                if ((a.ActionType == ActionType.UpdateRecord || a.ActionType == ActionType.DeleteRecord) && a.TargetNodeId.HasValue)
                {
                    var nodeId = a.TargetNodeId.Value;
                    if (!tree.Contains(nodeId))
                        issues.Add(ValidationIssue.Error("TRAV_NODE_NOT_FOUND", "Target node does not exist in the configuration.", IssueTarget.Action(a.Id, "TargetNodeId")));
                    else if (!tree.TrySingleCardinality(nodeId))
                        issues.Add(ValidationIssue.Error("TRAV_NOT_SINGLE_CARDINALITY", "Update/Delete must target a single-cardinality node.", IssueTarget.Action(a.Id, "TargetNodeId")));
                    else if (!tree.IsReachableFromRoot(nodeId))
                        issues.Add(ValidationIssue.Error("TRAV_NODE_UNREACHABLE", "Target node is not reachable from the root.", IssueTarget.Action(a.Id, "TargetNodeId")));
                }

                if ((a.ActionType == ActionType.CreateRecord || a.ActionType == ActionType.UpdateRecord)
                    && !string.IsNullOrWhiteSpace(a.FieldMapping))
                {
                    // The reference set splits a mapping's sources by cardinality: scalar operands
                    // (node/ref/template/dateexpr/mathexpr {node:...}) must be single-cardinality;
                    // aggregate operands (mathexpr sum/avg/min/max/count) must be many-cardinality
                    // (child) collections. The two buckets get opposite checks.
                    foreach (var nodeId in MappingNodes(model, a, ReferenceKind.MappingAggregateNodes))
                    {
                        if (!tree.Contains(nodeId))
                            issues.Add(ValidationIssue.Error("TRAV_NODE_NOT_FOUND",
                                "Aggregate field-mapping source node does not exist in the configuration.",
                                IssueTarget.Action(a.Id, "FieldMapping")));
                        else if (tree.TrySingleCardinality(nodeId))
                            issues.Add(ValidationIssue.Error("TRAV_AGGREGATE_NOT_COLLECTION",
                                "Aggregate field-mapping source must be a many-cardinality (child) collection.",
                                IssueTarget.Action(a.Id, "FieldMapping")));
                    }
                    foreach (var nodeId in MappingNodes(model, a, ReferenceKind.MappingSourceNodes))
                    {
                        if (!tree.Contains(nodeId))
                            issues.Add(ValidationIssue.Error("TRAV_NODE_NOT_FOUND",
                                "Field-mapping source node does not exist in the configuration.",
                                IssueTarget.Action(a.Id, "FieldMapping")));
                        else if (!tree.TrySingleCardinality(nodeId))
                            issues.Add(ValidationIssue.Error("TRAV_NOT_SINGLE_CARDINALITY",
                                "Field-mapping source node must be single-cardinality (root or lookup chain).",
                                IssueTarget.Action(a.Id, "FieldMapping")));
                    }
                }
            }

            foreach (var node in tree.NodesOfType(TableConfigType.LookupTable))
            {
                if (string.IsNullOrWhiteSpace(node.LookupTargetIdAttribute))
                {
                    issues.Add(ValidationIssue.Error(
                        "TRAV_LOOKUP_MISSING_TARGET_ID",
                        $"Lookup node '{node.TableLogicalName}' is missing its target id attribute (asx_lookuptargetidattribute) and cannot be traversed.",
                        IssueTarget.Rule(model.RuleId)));
                }
            }

            foreach (var g in model.AllGroups())
                foreach (var nf in FlattenFilterGroups(g.NodeFilterGroups))
                {
                    // Legacy/unowned filter groups (RuleConditionId == null) apply group-wide by
                    // back-compat design and have no single owning condition to anchor against.
                    if (nf.RuleConditionId.HasValue)
                    {
                        var owner = model.AllConditions().FirstOrDefault(c => c.Id == nf.RuleConditionId.Value);
                        if (owner != null && !tree.IsSelfOrAncestor(nf.TableConfigNodeId, owner.TableConfigNodeId))
                            issues.Add(ValidationIssue.Error("TRAV_FILTER_NODE_NOT_ANCESTOR",
                                "Node filter's target node is neither the owning condition's node nor an ancestor of it.",
                                IssueTarget.Rule(model.RuleId)));
                    }

                    foreach (var crit in nf.Criteria)
                    {
                        if (crit.Kind == CriterionKind.Exists)
                        {
                            CheckExistsCollectionNode(tree, crit.CollectionNodeId, IssueTarget.Rule(model.RuleId), issues);
                            continue;
                        }

                        if (crit.ValueSource != ComparisonValueSource.FieldReference || !crit.ComparisonValueNodeId.HasValue) continue;
                        var nodeId = crit.ComparisonValueNodeId.Value;
                        if (!tree.Contains(nodeId))
                            issues.Add(ValidationIssue.Error("TRAV_NODE_NOT_FOUND", "Filter field-reference node does not exist in the configuration.", IssueTarget.Rule(model.RuleId)));
                        else if (!tree.TrySingleCardinality(nodeId))
                            issues.Add(ValidationIssue.Error("TRAV_NOT_SINGLE_CARDINALITY", "Filter field-reference must target a single-cardinality node.", IssueTarget.Rule(model.RuleId)));
                        else if (!tree.IsReachableFromRoot(nodeId))
                            issues.Add(ValidationIssue.Error("TRAV_NODE_UNREACHABLE", "Filter field-reference node is not reachable from the root.", IssueTarget.Rule(model.RuleId)));
                    }
                }

            return issues;
        }

        // The distinct nodes one action's field mapping references under the given kind, read
        // from the rule's reference set (one issue per node per action, as before).
        private static IEnumerable<Guid> MappingNodes(RuleForValidation model, RuleAction action, ReferenceKind kind) =>
            model.References.ReferencesByKind(kind)
                .Where(r => r.ActionId == action.Id)
                .Select(r => r.NodeId)
                .Distinct();

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

        // An Exists criterion's collection node must exist and be a many-cardinality (child)
        // collection, because NodeFilterEvaluator.EvaluateExists relates the current node to it
        // via NodeRelate, which is only meaningful for a genuine 1:many collection. Shared by this
        // class's own condition-filter walk (above) and MetadataChecks.CheckAggregateFilters,
        // which has no TraversalChecks-equivalent walk of its own (mirrors how
        // CheckAggregateFilterValueNodeCardinality reuses the TRAV_NOT_SINGLE_CARDINALITY code)
        // and kept in one place instead of being reimplemented per surface.
        internal static void CheckExistsCollectionNode(TableConfigTree tree, Guid? collectionNodeId, IssueTarget target, List<ValidationIssue> issues)
        {
            if (!collectionNodeId.HasValue) return; // structural layer owns the missing-collection-node error
            if (!tree.TryGetNode(collectionNodeId.Value, out var node))
            {
                issues.Add(ValidationIssue.Error("TRAV_NODE_NOT_FOUND", "Exists collection node does not exist in the configuration.", target));
                return;
            }
            if (node.ConfigType != TableConfigType.ChildTable)
                issues.Add(ValidationIssue.Error("TRAV_EXISTS_NOT_COLLECTION", "Exists collection node must be a many-cardinality (child) collection.", target));
        }
    }
}
