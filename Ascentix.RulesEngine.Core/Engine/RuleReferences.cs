using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>Where a node reference came from. Every kind is enumerated by
    /// <see cref="RuleReferences.ReferencesByKind(ReferenceKind)"/>; the named answers
    /// (<see cref="RuleReferences.HardReaders"/>, <see cref="RuleReferences.FilterDerivedNodes"/>, …)
    /// are each built from an explicit list of kinds, never by subtracting one answer from another.</summary>
    public enum ReferenceKind
    {
        /// <summary>A condition's own node (LHS).</summary>
        ConditionNodes,
        /// <summary>A condition's RHS value node (<see cref="RuleCondition.ComparisonValueNodeId"/>).</summary>
        FieldReferenceNodes,
        /// <summary>A condition Template RHS <c>{node:guid.column}</c> token.</summary>
        TemplateNodes,
        /// <summary>A condition DateExpression RHS field anchor on a node.</summary>
        DateExprAnchors,
        /// <summary>A condition Expression scalar <c>{node:guid.column}</c> operand.</summary>
        MathExprScalarNodes,
        /// <summary>A condition Expression aggregate operand (sum/avg/min/max/count over a node);
        /// <see cref="NodeReference.FilterKey"/> carries its <c>filter:</c> key when present.</summary>
        MathExprAggregateNodes,
        /// <summary>A node-filter group's target node (top-level and nested groups).</summary>
        FilterTargetNodes,
        /// <summary>A node-filter criterion's RHS value node (outside EXISTS sub-filters).</summary>
        FilterValueNodes,
        /// <summary>An EXISTS criterion's collection node, at any depth.</summary>
        ExistsCollections,
        /// <summary>A criterion RHS value node inside an EXISTS sub-filter, at any depth.</summary>
        SubFilterNodes,
        /// <summary>An Update/Delete action's target node.</summary>
        ActionTargetNodes,
        /// <summary>A field-mapping single-cardinality source: node/ref, template token,
        /// dateexpr anchor, mathexpr scalar operand.</summary>
        MappingSourceNodes,
        /// <summary>A field-mapping mathexpr aggregate operand (many-cardinality);
        /// <see cref="NodeReference.FilterKey"/> carries its <c>filter:</c> key when present.</summary>
        MappingAggregateNodes,
        /// <summary>A node referenced inside a field-mapping aggregate filter (value nodes, EXISTS
        /// collections and their sub-filters).</summary>
        MappingFilterNodes,
        /// <summary>A <c>{node:guid.column}</c> token in an action's Message or a localized variant.</summary>
        MessageNodes,
    }

    /// <summary>One node reference with its provenance.</summary>
    public sealed class NodeReference
    {
        internal NodeReference(Guid nodeId, ReferenceKind kind, Guid? conditionId, Guid? actionId, string filterKey)
        {
            NodeId = nodeId;
            Kind = kind;
            ConditionId = conditionId;
            ActionId = actionId;
            FilterKey = filterKey;
        }

        public Guid NodeId { get; }
        public ReferenceKind Kind { get; }
        /// <summary>The condition that carries the reference (conditions and owned filters), or null.</summary>
        public Guid? ConditionId { get; }
        /// <summary>The action that carries the reference (targets, mappings, messages), or null.</summary>
        public Guid? ActionId { get; }
        /// <summary>Aggregate operands only: the <c>filter:&lt;key&gt;</c> the aggregate names, or null.</summary>
        public string FilterKey { get; }
    }

    /// <summary>
    /// The rule reference set: ONE computation, per mapped rule (or per bucket of rules), of
    /// everything the rule touches: condition groups (including node-filter groups, EXISTS
    /// criteria and their sub-filters) and ACTIVE actions (targets, parsed field mappings,
    /// Message and LocalizedMessages). Every downstream consumer (the runner's config seed and
    /// query plan, the validator's config set, the pushdown demand proof, column pruning, the
    /// root ColumnSet, the step planner's root-only verdict, the rule serializer) reads a named
    /// answer here instead of walking the ConditionGroup / NodeFilterCriterion / FieldMappingEntry
    /// trees again.
    ///
    /// Named answers:
    ///  - <see cref="NodesToLoad"/>: every structurally referenced node (config-load seed; required).
    ///  - <see cref="OptionalNodes"/>: nodes referenced ONLY by message tokens. Loaded when they
    ///    exist, but a stale token degrades to raw text rather than refusing the save.
    ///  - <see cref="NodesToPlan"/>: extra nodes for <see cref="QueryExecutionPlan.Build(TableConfigTree, List{RuleCondition}, IEnumerable{Guid})"/>
    ///    beyond condition LHS/RHS.
    ///  - <see cref="HardReaders"/>: nodes read by consumers whose rows/columns cannot be
    ///    enumerated; they demand an unfiltered fetch. Built from its OWN kind list.
    ///  - <see cref="FilterDerivedNodes"/>: node-filter targets, filter value nodes, EXISTS
    ///    collections and sub-filter nodes. Loaded and planned; the pushdown planner proves their
    ///    demand itself (a self-targeting filter is served by its variant).
    ///  - <see cref="Unpruneable"/>: hard readers ∪ filter-derived, never column-pruned.
    ///  - <see cref="RootColumns"/> / <see cref="IsRootOnly"/>: the root ColumnSet and the
    ///    step-gating verdict; both need the tree, so they take it.
    ///  - <see cref="ReferencesByKind(ReferenceKind)"/>: provenance enumerations.
    ///
    /// Policy: ACTIVE actions only. An inactive action never executes
    /// (<see cref="ActionDispatcher.ComputeFiredActions"/> filters <see cref="RuleAction.IsActive"/>),
    /// so its nodes would be pure over-fetch. A payload that does not parse (mapping JSON,
    /// template, date expression, math expression) contributes no references: the evaluator
    /// surfaces the real error at runtime and <c>StructuralChecks</c> reports it at publish.
    /// </summary>
    public sealed class RuleReferences
    {
        private static readonly ReferenceKind[] HardReaderKinds =
        {
            ReferenceKind.ActionTargetNodes,
            ReferenceKind.MappingSourceNodes,
            ReferenceKind.MappingAggregateNodes,
            ReferenceKind.MappingFilterNodes,
            ReferenceKind.TemplateNodes,
            ReferenceKind.DateExprAnchors,
            ReferenceKind.MathExprScalarNodes,
            ReferenceKind.MathExprAggregateNodes,
            ReferenceKind.MessageNodes,
        };

        private static readonly ReferenceKind[] FilterDerivedKinds =
        {
            ReferenceKind.FilterTargetNodes,
            ReferenceKind.FilterValueNodes,
            ReferenceKind.ExistsCollections,
            ReferenceKind.SubFilterNodes,
        };

        private static readonly ReferenceKind[] StructuralKinds =
            Enum.GetValues(typeof(ReferenceKind)).Cast<ReferenceKind>()
                .Where(k => k != ReferenceKind.MessageNodes).ToArray();

        private readonly List<NodeReference> _references = new List<NodeReference>();
        // (node, column) pairs the rule reads; a null node means the triggering ROOT record
        // (template {root.col}, dateexpr root anchor, mathexpr {root.col}, "root" mapping source).
        private readonly List<(Guid? node, string column)> _columns = new List<(Guid?, string)>();
        private bool _hasUnboundCondition;

        private HashSet<Guid> _nodesToLoad, _optional, _hard, _filterDerived, _plan, _unpruneable;

        private RuleReferences() { }

        /// <summary>Computes the reference set for a set of mapped condition groups and actions
        /// (one rule, or every rule of a bucket). <paramref name="parseMapping"/> lets a caller
        /// share its parsed-mapping cache; by default <see cref="FieldMappingParser.Parse"/> runs.</summary>
        public static RuleReferences Compute(
            IEnumerable<ConditionGroup> rootGroups,
            IEnumerable<RuleAction> actions,
            Func<RuleAction, List<FieldMappingEntry>> parseMapping = null)
        {
            var refs = new RuleReferences();
            foreach (var group in AllGroups(rootGroups))
            {
                foreach (var c in group.Conditions ?? new List<RuleCondition>()) refs.AddCondition(c);
                foreach (var f in AllFilterGroups(group.NodeFilterGroups)) refs.AddFilterGroup(f);
            }
            foreach (var a in (actions ?? Enumerable.Empty<RuleAction>()).Where(a => a != null && a.IsActive))
                refs.AddAction(a, parseMapping);
            refs.Seal();
            return refs;
        }

        // ─── Named answers ──────────────────────────────────────────────────

        /// <summary>Every structurally referenced node id, the required config-load seed.</summary>
        public IReadOnlyCollection<Guid> NodesToLoad => _nodesToLoad;

        /// <summary>Nodes referenced only by message tokens (<see cref="ReferenceKind.MessageNodes"/>
        /// minus <see cref="NodesToLoad"/>): loaded as OPTIONAL so an unknown token degrades to raw
        /// text instead of refusing the save.</summary>
        public IReadOnlyCollection<Guid> OptionalNodes => _optional;

        /// <summary>Extra nodes for the query plan beyond condition LHS/RHS (hard readers ∪ filter-derived).</summary>
        public IReadOnlyCollection<Guid> NodesToPlan => _plan;

        /// <summary>Nodes whose consumers cannot be enumerated (write targets; mapping node/ref/
        /// template/dateexpr/mathexpr refs and aggregate-filter nodes; condition template tokens,
        /// date-expression anchors and expression operands; message tokens). Demand an unfiltered fetch.</summary>
        public IReadOnlyCollection<Guid> HardReaders => _hard;

        /// <summary>Node-filter targets, filter value nodes, EXISTS collections and sub-filter nodes.</summary>
        public IReadOnlyCollection<Guid> FilterDerivedNodes => _filterDerived;

        /// <summary>Hard readers ∪ filter-derived nodes: never column-pruned.</summary>
        public IReadOnlyCollection<Guid> Unpruneable => _unpruneable;

        public IReadOnlyList<NodeReference> ReferencesByKind(ReferenceKind kind) =>
            _references.Where(r => r.Kind == kind).ToList();

        /// <summary>Distinct node ids across the given kinds.</summary>
        public HashSet<Guid> NodeIds(params ReferenceKind[] kinds)
        {
            var set = new HashSet<Guid>();
            foreach (var r in _references)
                if (Array.IndexOf(kinds, r.Kind) >= 0) set.Add(r.NodeId);
            return set;
        }

        /// <summary>
        /// The columns the engine reads off the ROOT record: condition LHS/RHS on a root; a
        /// FieldReference RHS column when its side is a root; template <c>{root.x}</c> tokens,
        /// root date-expression anchors and root expression operands (all rendered against the
        /// triggering record whatever node the condition sits on); root-targeted filter criterion
        /// fields and root-side criterion RHS columns; EXISTS sub-filter root fields; RowCount
        /// search-criteria fields on a root; the lookup columns of root-parented lookup nodes;
        /// Create/Update field-mapping root sources; and message <c>{root.col}</c> tokens (Block /
        /// Show Message text is rendered on Update/Delete too, where the root read is column-scoped).
        /// "On the root" means on ANY root: rules evaluated together may come from different
        /// trees on the same table.
        /// </summary>
        public HashSet<string> RootColumns(TableConfigTree tree)
        {
            var cols = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (tree == null) return cols;
            var rootIds = RootIds(tree);
            if (rootIds.Count == 0) return cols;

            foreach (var (node, column) in _columns)
                if (!node.HasValue || rootIds.Contains(node.Value)) cols.Add(column);

            foreach (var cfg in tree.NodesOfType(TableConfigType.LookupTable))
                if (cfg.ParentTableId.HasValue && rootIds.Contains(cfg.ParentTableId.Value)
                    && !string.IsNullOrWhiteSpace(cfg.LookupColumnLogicalName))
                    cols.Add(cfg.LookupColumnLogicalName);

            return cols;
        }

        /// <summary>
        /// True when every node the rule references (of ANY kind: conditions, field references,
        /// template / date-expression / expression operands, node filters, EXISTS collections and
        /// sub-filters, action targets, field-mapping sources, message tokens) is a Root Table
        /// node, i.e. the rule never traverses. Only such a rule is safe to gate behind filtering
        /// attributes (its outcome is a pure function of root columns). A tree with no root, or
        /// a referenced node the tree does not hold, answers false (fail closed: the rule is
        /// evaluated on every save rather than gated).
        /// </summary>
        public bool IsRootOnly(TableConfigTree tree)
        {
            if (tree == null) return false;
            var rootIds = RootIds(tree);
            if (rootIds.Count == 0) return false;
            if (_hasUnboundCondition) return false;
            return _nodesToLoad.All(rootIds.Contains) && _optional.All(rootIds.Contains);
        }

        // ─── Collection ─────────────────────────────────────────────────────

        private void Seal()
        {
            _nodesToLoad = NodeIds(StructuralKinds);
            _optional = NodeIds(ReferenceKind.MessageNodes);
            _optional.ExceptWith(_nodesToLoad);
            _hard = NodeIds(HardReaderKinds);
            _filterDerived = NodeIds(FilterDerivedKinds);
            _plan = new HashSet<Guid>(_hard);
            _plan.UnionWith(_filterDerived);
            _unpruneable = new HashSet<Guid>(_plan);
        }

        private void Add(Guid? nodeId, ReferenceKind kind, Guid? conditionId = null, Guid? actionId = null, string filterKey = null)
        {
            if (!nodeId.HasValue || nodeId.Value == Guid.Empty) return;
            _references.Add(new NodeReference(nodeId.Value, kind, conditionId, actionId, filterKey));
        }

        private void AddColumn(Guid? node, string column)
        {
            if (!string.IsNullOrWhiteSpace(column)) _columns.Add((node, column));
        }

        private void AddCondition(RuleCondition c)
        {
            var own = c.TableConfigNodeId;
            if (own == Guid.Empty) _hasUnboundCondition = true;
            Add(own, ReferenceKind.ConditionNodes, c.Id);
            AddColumn(own, c.ComparisonColumn);

            Add(c.ComparisonValueNodeId, ReferenceKind.FieldReferenceNodes, c.Id);
            if (c.ValueSource == ComparisonValueSource.FieldReference)
                AddColumn(c.ComparisonValueNodeId ?? own, c.ComparisonValueColumn);
            else if (c.ValueSource == ComparisonValueSource.Template && !string.IsNullOrWhiteSpace(c.ComparisonValue))
            {
                foreach (var seg in TokenizeLenient(c.ComparisonValue))
                {
                    Add(seg.Node, ReferenceKind.TemplateNodes, c.Id);
                    AddColumn(seg.Node, seg.Column);
                }
            }
            else if (c.ValueSource == ComparisonValueSource.DateExpression && !string.IsNullOrWhiteSpace(c.ComparisonValue))
            {
                try
                {
                    var spec = DateExprSpec.Parse(c.ComparisonValue);
                    if (spec.AnchorKind == "field")
                    {
                        Add(spec.AnchorNode, ReferenceKind.DateExprAnchors, c.Id);
                        AddColumn(spec.AnchorNode, spec.AnchorColumn);
                    }
                }
                catch (InvalidPluginExecutionException) { /* evaluation surfaces the real error */ }
            }

            // Independent of the RHS source: an Expression's LHS operands are read whatever the
            // RHS is (FieldReference / Template / DateExpression / Literal).
            if (c.ConditionType == ConditionType.Expression && !string.IsNullOrWhiteSpace(c.Expression))
            {
                var ast = ParseLenient(c.Expression, $"Condition {c.Id}");
                if (ast != null)
                {
                    foreach (var r in MathExpr.ScalarRefs(ast))
                    {
                        Add(r.node, ReferenceKind.MathExprScalarNodes, c.Id);
                        AddColumn(r.node, r.column);
                    }
                    foreach (var ag in MathExpr.AggregateNodes(ast))
                    {
                        Add(ag.Node, ReferenceKind.MathExprAggregateNodes, c.Id, filterKey: ag.FilterKey);
                        AddColumn(ag.Node, ag.Column);
                    }
                }
            }

            foreach (var sg in AllSearchGroups(c.SearchCriteriaGroups))
                foreach (var crit in sg.Criteria ?? new List<SearchCriterion>())
                    AddColumn(own, crit.FieldName);
        }

        private void AddFilterGroup(NodeFilterGroup f)
        {
            var target = f.TableConfigNodeId;
            Add(target, ReferenceKind.FilterTargetNodes, f.RuleConditionId);
            foreach (var crit in f.Criteria ?? new List<NodeFilterCriterion>())
            {
                AddColumn(target, crit.FieldName);
                Add(crit.ComparisonValueNodeId, ReferenceKind.FilterValueNodes, f.RuleConditionId);
                if (crit.ValueSource == ComparisonValueSource.FieldReference)
                    AddColumn(crit.ComparisonValueNodeId ?? target, crit.ComparisonValueColumn);
                if (crit.Kind == CriterionKind.Exists)
                    AddExists(crit, f.RuleConditionId);
            }
        }

        // An EXISTS criterion counts rows of its collection node; its sub-filter (and any EXISTS
        // nested inside it) reads that collection's rows. The sub-filter hangs off the criterion,
        // not the group's ChildGroups chain, so it is walked here.
        private void AddExists(NodeFilterCriterion crit, Guid? conditionId)
        {
            Add(crit.CollectionNodeId, ReferenceKind.ExistsCollections, conditionId);
            foreach (var sub in AllFilterGroups(crit.SubFilter == null ? null : new[] { crit.SubFilter }))
                foreach (var sc in sub.Criteria ?? new List<NodeFilterCriterion>())
                {
                    AddColumn(crit.CollectionNodeId, sc.FieldName);
                    Add(sc.ComparisonValueNodeId, ReferenceKind.SubFilterNodes, conditionId);
                    if (sc.ValueSource == ComparisonValueSource.FieldReference)
                        AddColumn(sc.ComparisonValueNodeId ?? crit.CollectionNodeId, sc.ComparisonValueColumn);
                    if (sc.Kind == CriterionKind.Exists)
                        AddExists(sc, conditionId);
                }
        }

        private void AddAction(RuleAction a, Func<RuleAction, List<FieldMappingEntry>> parseMapping)
        {
            if ((a.ActionType == ActionType.UpdateRecord || a.ActionType == ActionType.DeleteRecord) && a.TargetNodeId.HasValue)
                Add(a.TargetNodeId, ReferenceKind.ActionTargetNodes, actionId: a.Id);

            if (!string.IsNullOrWhiteSpace(a.FieldMapping))
            {
                List<FieldMappingEntry> entries;
                try { entries = (parseMapping ?? (x => FieldMappingParser.Parse(x.FieldMapping)))(a); }
                catch (InvalidPluginExecutionException) { entries = null; }

                // Root-source columns are copied by Create/Update only: the one mapping rule
                // that is action-type dependent, kept explicit.
                var copiesRoot = a.ActionType == ActionType.CreateRecord || a.ActionType == ActionType.UpdateRecord;
                foreach (var entry in entries ?? new List<FieldMappingEntry>())
                {
                    try
                    {
                        foreach (var id in FieldMappingReferences.SingleCardinalityNodeIds(entry))
                            Add(id, ReferenceKind.MappingSourceNodes, actionId: a.Id);
                        foreach (var ag in FieldMappingReferences.AggregateNodes(entry))
                            Add(ag.Node, ReferenceKind.MappingAggregateNodes, actionId: a.Id, filterKey: ag.FilterKey);
                        if (entry.Filters != null)
                            foreach (var group in entry.Filters.Values)
                                foreach (var id in FieldMappingReferences.FilterCriterionNodeIds(group))
                                    Add(id, ReferenceKind.MappingFilterNodes, actionId: a.Id);
                        if (copiesRoot)
                            foreach (var col in FieldMappingReferences.RootColumns(entry))
                                AddColumn(null, col);
                    }
                    catch (InvalidPluginExecutionException) { /* malformed template/expression: evaluation reports it */ }
                }
            }

            AddMessage(a.Message, a.Id);
            if (a.LocalizedMessages != null)
                foreach (var text in a.LocalizedMessages.Values) AddMessage(text, a.Id);
        }

        private void AddMessage(string text, Guid actionId)
        {
            if (string.IsNullOrWhiteSpace(text)) return;
            foreach (var seg in TokenizeLenient(text))
            {
                Add(seg.Node, ReferenceKind.MessageNodes, actionId: actionId);
                AddColumn(seg.Node, seg.Column);
            }
        }

        // ─── Helpers ────────────────────────────────────────────────────────

        private static HashSet<Guid> RootIds(TableConfigTree tree) =>
            new HashSet<Guid>(tree.Roots.Select(r => r.Id));

        private static IEnumerable<TemplateRenderer.Segment> TokenizeLenient(string template)
        {
            List<TemplateRenderer.Segment> segs;
            try { segs = TemplateRenderer.Tokenize(template, "reference"); }
            catch (InvalidPluginExecutionException) { return Enumerable.Empty<TemplateRenderer.Segment>(); }
            return segs.Where(s => !s.IsLiteral);
        }

        private static MathExprNode ParseLenient(string expression, string context)
        {
            try { return MathExpr.Parse(expression, context); }
            catch (InvalidPluginExecutionException) { return null; }
        }

        private static IEnumerable<ConditionGroup> AllGroups(IEnumerable<ConditionGroup> groups)
        {
            foreach (var g in groups ?? Enumerable.Empty<ConditionGroup>())
            {
                if (g == null) continue;
                yield return g;
                foreach (var d in AllGroups(g.ChildGroups)) yield return d;
            }
        }

        private static IEnumerable<NodeFilterGroup> AllFilterGroups(IEnumerable<NodeFilterGroup> groups)
        {
            foreach (var g in groups ?? Enumerable.Empty<NodeFilterGroup>())
            {
                if (g == null) continue;
                yield return g;
                foreach (var d in AllFilterGroups(g.ChildGroups)) yield return d;
            }
        }

        private static IEnumerable<SearchCriteriaGroup> AllSearchGroups(IEnumerable<SearchCriteriaGroup> groups)
        {
            foreach (var g in groups ?? Enumerable.Empty<SearchCriteriaGroup>())
            {
                if (g == null) continue;
                yield return g;
                foreach (var d in AllSearchGroups(g.ChildGroups)) yield return d;
            }
        }
    }
}
