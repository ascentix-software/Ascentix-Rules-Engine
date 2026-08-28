using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>The pushdown planner's variant assignment and, critically, the unfiltered-demand
    /// proof: a node skips its unfiltered fetch only when nothing can possibly read it.</summary>
    public class PushdownPlannerTests
    {
        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid ChildId = Guid.NewGuid();
        private static readonly Guid SiblingId = Guid.NewGuid();

        private static TableConfigTree Configs() => TestTree.Tree(
            new TableConfig { Id = RootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable },
            new TableConfig { Id = ChildId, TableLogicalName = "contact", ConfigType = TableConfigType.ChildTable, ChildLinkField = "parentcustomerid", ParentTableId = RootId },
            new TableConfig { Id = SiblingId, TableLogicalName = "task", ConfigType = TableConfigType.ChildTable, ChildLinkField = "regardingobjectid", ParentTableId = RootId }
        );

        private static QueryExecutionPlan Plan(params Guid[] nodeIds)
        {
            var configs = Configs();
            var plan = new QueryExecutionPlan();
            plan.Levels.Add(nodeIds.Select(id => new ExecutionPlanEntry { Node = configs.Node(id), ParentCacheKey = RootId.ToString() }).ToList());
            return plan;
        }

        private static RuleCondition Cond(Guid nodeId) => new RuleCondition
        { Id = Guid.NewGuid(), TableConfigNodeId = nodeId, ConditionType = ConditionType.RowCount, MinExpectedRows = 1 };

        private static ConditionGroup Group(RuleCondition c, params NodeFilterGroup[] filters) => new ConditionGroup
        {
            Id = Guid.NewGuid(),
            Conditions = new List<RuleCondition> { c },
            NodeFilterGroups = filters.ToList(),
        };

        private static NodeFilterGroup SelfFilter(Guid target, Guid conditionId, string field = "statuscode", string op = "eq", string value = "1")
            => new NodeFilterGroup
            {
                TableConfigNodeId = target,
                RuleConditionId = conditionId,
                LogicalOperator = LogicalOperator.And,
                Criteria = { new NodeFilterCriterion { FieldName = field, Operator = op, Value = value } },
            };

        [Fact]
        public void Fully_pushed_leaf_condition_skips_unfiltered_and_gets_variant()
        {
            var c = Cond(ChildId);
            var plan = Plan(ChildId);
            var result = PushdownPlanner.Apply(plan, Configs(),
                new List<ConditionGroup> { Group(c, SelfFilter(ChildId, c.Id)) }, null);

            var entry = plan.Levels[0][0];
            Assert.False(entry.DemandsUnfiltered);        // the 3M-row proof
            Assert.Single(entry.Variants);
            Assert.Contains("statuscode", entry.Variants[0].FilterFetchXml);
            Assert.Equal(entry.Variants[0].Key, result.ConditionVariantKeys[c.Id]);
        }

        [Fact]
        public void Hard_reader_reference_forces_unfiltered_even_with_variant()
        {
            var c = Cond(ChildId);
            var plan = Plan(ChildId);
            PushdownPlanner.Apply(plan, Configs(),
                new List<ConditionGroup> { Group(c, SelfFilter(ChildId, c.Id)) }, new[] { ChildId });

            var entry = plan.Levels[0][0];
            Assert.True(entry.DemandsUnfiltered);
            Assert.Single(entry.Variants);                // variant still runs for the condition
        }

        [Fact]
        public void Unfiltered_condition_demands_unfiltered_with_no_variant()
        {
            var c = Cond(ChildId);
            var plan = Plan(ChildId);
            var result = PushdownPlanner.Apply(plan, Configs(), new List<ConditionGroup> { Group(c) }, null);

            Assert.True(plan.Levels[0][0].DemandsUnfiltered);
            Assert.Empty(plan.Levels[0][0].Variants);
            Assert.Empty(result.ConditionVariantKeys);
        }

        [Fact]
        public void Unpushable_filter_falls_back_to_unfiltered()
        {
            var c = Cond(ChildId);
            // `contains` is refused by the planner's translator (no per-column metadata yet).
            var plan = Plan(ChildId);
            var result = PushdownPlanner.Apply(plan, Configs(),
                new List<ConditionGroup> { Group(c, SelfFilter(ChildId, c.Id, op: "contains", value: "x")) }, null);

            Assert.True(plan.Levels[0][0].DemandsUnfiltered);
            Assert.Empty(result.ConditionVariantKeys);
        }

        [Fact]
        public void Ancestor_targeting_filter_demands_the_ancestor_node()
        {
            var c = Cond(ChildId);
            var ancestorFilter = SelfFilter(RootId, c.Id); // targets root, not the condition's node
            var plan = Plan(ChildId);
            PushdownPlanner.Apply(plan, Configs(),
                new List<ConditionGroup> { Group(c, ancestorFilter, SelfFilter(ChildId, c.Id)) }, null);

            // Child still gets its variant; the ancestor target lands in demand (root is seeded,
            // not planned, so nothing to assert on an entry). The proof: child stays skippable.
            Assert.False(plan.Levels[0][0].DemandsUnfiltered);
            Assert.Single(plan.Levels[0][0].Variants);
        }

        [Fact]
        public void Identical_filters_share_one_variant()
        {
            var c1 = Cond(ChildId);
            var c2 = Cond(ChildId);
            var g1 = Group(c1, SelfFilter(ChildId, c1.Id));
            var g2 = Group(c2, SelfFilter(ChildId, c2.Id));
            var plan = Plan(ChildId);
            var result = PushdownPlanner.Apply(plan, Configs(), new List<ConditionGroup> { g1, g2 }, null);

            Assert.Single(plan.Levels[0][0].Variants);
            Assert.Equal(result.ConditionVariantKeys[c1.Id], result.ConditionVariantKeys[c2.Id]);
        }

        [Fact]
        public void Search_criteria_produce_a_variant()
        {
            var c = Cond(ChildId);
            c.SearchCriteriaGroups.Add(new SearchCriteriaGroup
            {
                LogicalOperator = LogicalOperator.And,
                Criteria = { new SearchCriterion { FieldName = "statecode", Operator = "eq", Value = "0" } },
            });
            var plan = Plan(ChildId);
            var result = PushdownPlanner.Apply(plan, Configs(), new List<ConditionGroup> { Group(c) }, null);

            Assert.False(plan.Levels[0][0].DemandsUnfiltered);
            Assert.Contains("statecode", plan.Levels[0][0].Variants.Single().FilterFetchXml);
            Assert.True(result.ConditionVariantKeys.ContainsKey(c.Id));
        }

        [Fact]
        public void String_literal_ne_is_refused_and_demands_unfiltered()
        {
            // The collation-narrowing rule: string-literal ne cannot
            // push; the condition falls back to the in-memory path over unfiltered rows.
            var c = Cond(ChildId);
            var plan = Plan(ChildId);
            var result = PushdownPlanner.Apply(plan, Configs(),
                new List<ConditionGroup> { Group(c, SelfFilter(ChildId, c.Id, field: "sample_notes", op: "ne", value: "Alpha")) }, null);

            Assert.True(plan.Levels[0][0].DemandsUnfiltered);
            Assert.Empty(result.ConditionVariantKeys);
        }

        [Fact]
        public void Numeric_ne_still_pushes_widened()
        {
            var c = Cond(ChildId);
            var plan = Plan(ChildId);
            var result = PushdownPlanner.Apply(plan, Configs(),
                new List<ConditionGroup> { Group(c, SelfFilter(ChildId, c.Id, op: "ne", value: "100")) }, null);

            Assert.False(plan.Levels[0][0].DemandsUnfiltered);
            var v = plan.Levels[0][0].Variants.Single();
            Assert.Contains("operator='ne'", v.FilterFetchXml);
            Assert.Contains("operator='null'", v.FilterFetchXml); // OR-null widening arm
            Assert.Equal(v.Key, result.ConditionVariantKeys[c.Id]);
        }

        [Fact]
        public void Exists_criterion_collection_node_is_demanded()
        {
            var c = Cond(ChildId);
            var filter = SelfFilter(ChildId, c.Id);
            filter.Criteria.Add(new NodeFilterCriterion
            { Kind = CriterionKind.Exists, CollectionNodeId = ChildId });
            var plan = Plan(ChildId);
            PushdownPlanner.Apply(plan, Configs(), new List<ConditionGroup> { Group(c, filter) }, null);

            // The EXISTS arm reads the collection's unfiltered cache, so demand must hold.
            Assert.True(plan.Levels[0][0].DemandsUnfiltered);
        }

        // ─── The planner reads the rule reference set's answers ─────────────

        [Fact]
        public void Message_token_nodes_are_hard_readers_and_force_unfiltered()
        {
            // A Block message naming the child node is a reader the planner cannot enumerate:
            // the reference set puts it in HardReaders, and the proof must keep the fetch.
            var c = Cond(ChildId);
            var block = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.Block, IsActive = true, Message = $"{{node:{ChildId}.fullname}}" };
            var refs = RuleReferences.Compute(new List<ConditionGroup> { Group(c, SelfFilter(ChildId, c.Id)) }, new[] { block });
            Assert.Contains(ChildId, refs.HardReaders);

            var plan = Plan(ChildId);
            PushdownPlanner.Apply(plan, Configs(), new List<ConditionGroup> { Group(c, SelfFilter(ChildId, c.Id)) }, refs.HardReaders, refs.FilterDerivedNodes);

            Assert.True(plan.Levels[0][0].DemandsUnfiltered);
            Assert.Single(plan.Levels[0][0].Variants);
        }

        [Fact]
        public void Self_filter_targets_are_not_hard_readers_so_the_variant_still_skips_unfiltered()
        {
            // The filter target is filter-derived, not a hard reader: handing the reference set's
            // answers to the planner must leave the 3M-row proof intact.
            var c = Cond(ChildId);
            var groups = new List<ConditionGroup> { Group(c, SelfFilter(ChildId, c.Id)) };
            var refs = RuleReferences.Compute(groups, null);
            Assert.DoesNotContain(ChildId, refs.HardReaders);
            Assert.Contains(ChildId, refs.FilterDerivedNodes);

            var plan = Plan(ChildId);
            PushdownPlanner.Apply(plan, Configs(), groups, refs.HardReaders, refs.FilterDerivedNodes);

            Assert.False(plan.Levels[0][0].DemandsUnfiltered);
            Assert.Single(plan.Levels[0][0].Variants);
        }

        [Fact]
        public void Exists_subfilter_value_node_with_a_variant_elsewhere_is_demanded_unfiltered()
        {
            // Condition A on the child pushes a self filter (variant on the child). Condition
            // B's filter carries an EXISTS whose SUB-FILTER reads the child's rows as a value node.
            // The sub-filter hangs off the criterion, not the ChildGroups chain, so an
            // ownership-independent pass that misses it would leave the child with a variant and
            // undemanded, and the sub-filter would read an entry that was never fetched.
            var a = Cond(ChildId);
            var b = Cond(RootId);
            var existsFilter = new NodeFilterGroup
            {
                TableConfigNodeId = RootId, RuleConditionId = b.Id, LogicalOperator = LogicalOperator.And,
                Criteria =
                {
                    new NodeFilterCriterion
                    {
                        Kind = CriterionKind.Exists, CollectionNodeId = SiblingId, MinCount = 1,
                        SubFilter = new NodeFilterGroup
                        {
                            LogicalOperator = LogicalOperator.And,
                            Criteria = { new NodeFilterCriterion { FieldName = "ownerid", Operator = "eq", ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = ChildId, ComparisonValueColumn = "ownerid" } },
                        },
                    },
                },
            };
            var groups = new List<ConditionGroup> { Group(a, SelfFilter(ChildId, a.Id)), Group(b, existsFilter) };
            var refs = RuleReferences.Compute(groups, null);
            Assert.Contains(ChildId, refs.NodeIds(ReferenceKind.SubFilterNodes));

            var plan = Plan(ChildId);
            PushdownPlanner.Apply(plan, Configs(), groups, refs.HardReaders, refs.FilterDerivedNodes);

            Assert.True(plan.Levels[0][0].DemandsUnfiltered);
            Assert.Single(plan.Levels[0][0].Variants);   // A's variant still runs
        }

        [Fact]
        public void Foreign_owned_ancestor_filter_target_with_a_variant_elsewhere_is_demanded_unfiltered()
        {
            // Condition A pushes a self filter on the child (variant). Another group carries a
            // filter whose RuleConditionId names a condition outside that group and whose TARGET
            // is the child. No condition's pass owns it, so a proof that looked only at condition
            // passes would not demand the target, and the variant elsewhere would skip the
            // unfiltered fetch the filter reads.
            var a = Cond(ChildId);
            var foreignOwned = SelfFilter(ChildId, Guid.NewGuid()); // owner lives in some other group
            var groups = new List<ConditionGroup> { Group(a, SelfFilter(ChildId, a.Id)), Group(Cond(RootId), foreignOwned) };
            var refs = RuleReferences.Compute(groups, null);

            var plan = Plan(ChildId);
            PushdownPlanner.Apply(plan, Configs(), groups, refs.HardReaders, refs.FilterDerivedNodes);

            Assert.True(plan.Levels[0][0].DemandsUnfiltered);
            Assert.Single(plan.Levels[0][0].Variants);
        }
    }
}
