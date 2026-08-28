using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Actions;
using Ascentix.RulesEngine.Core.Engine;
using Ascentix.RulesEngine.Core.Models;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Property facts over a generator that covers EVERY reference kind. The validator
    /// (RuleValidationLoader) and the runner (RulesEngineRunner.RunBucket) both read the ONE
    /// reference set rather than each walking the rule on their own, so the property
    /// degenerates to per-kind coverage of that set, which is the point: a kind added to one
    /// consumer and forgotten in another cannot happen.
    /// </summary>
    public class RuleReferencesPropertyTests
    {
        private static readonly Guid RootId = Guid.NewGuid();
        private static readonly Guid LookupId = Guid.NewGuid();
        private static readonly Guid ChildId = Guid.NewGuid();
        private static readonly Guid SiblingId = Guid.NewGuid();

        private sealed class Case
        {
            public string Name;
            public List<ConditionGroup> Groups = new List<ConditionGroup>();
            public List<RuleAction> Actions = new List<RuleAction>();
            public Dictionary<Guid, List<FieldMappingEntry>> Mappings = new Dictionary<Guid, List<FieldMappingEntry>>();
            public Guid Node;
            public ReferenceKind Kind;
            public bool Hard;
            public bool FilterDerived;
            public bool MessageOnly;
        }

        private static RuleCondition RootCond() => new RuleCondition
        { Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = "name", ComparisonOperator = ComparisonOperator.IsNotNull };

        private static Case ConditionCase(string name, RuleCondition c, Guid node, ReferenceKind kind, bool hard = false) =>
            new Case { Name = name, Groups = { new ConditionGroup { Id = Guid.NewGuid(), Conditions = { c } } }, Node = node, Kind = kind, Hard = hard };

        private static Case FilterCase(string name, Guid conditionNode, NodeFilterGroup filter, Guid node, ReferenceKind kind)
        {
            var c = new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = conditionNode, ConditionType = ConditionType.RowCount, MinExpectedRows = 1 };
            filter.RuleConditionId = c.Id;
            return new Case
            {
                Name = name,
                Groups = { new ConditionGroup { Id = Guid.NewGuid(), Conditions = { c }, NodeFilterGroups = { filter } } },
                Node = node, Kind = kind, FilterDerived = true,
            };
        }

        private static Case MappingCase(string name, FieldMappingEntry entry, Guid node, ReferenceKind kind)
        {
            var a = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.CreateRecord, IsActive = true, FieldMapping = "delegate" };
            var c = new Case { Name = name, Actions = { a }, Node = node, Kind = kind, Hard = true };
            c.Groups.Add(new ConditionGroup { Id = Guid.NewGuid(), Conditions = { RootCond() } });
            c.Mappings[a.Id] = new List<FieldMappingEntry> { entry };
            return c;
        }

        private static NodeFilterGroup Filter(Guid target, params NodeFilterCriterion[] criteria) =>
            new NodeFilterGroup { TableConfigNodeId = target, LogicalOperator = LogicalOperator.And, Criteria = criteria.ToList() };

        private static NodeFilterCriterion FieldRef(Guid node) => new NodeFilterCriterion
        { FieldName = "ownerid", Operator = "eq", ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = node, ComparisonValueColumn = "ownerid" };

        private static NodeFilterCriterion Exists(Guid collection, NodeFilterGroup subFilter = null) => new NodeFilterCriterion
        { Kind = CriterionKind.Exists, CollectionNodeId = collection, MinCount = 1, SubFilter = subFilter };

        private static IEnumerable<Case> Cases()
        {
            yield return ConditionCase("condition LHS on a lookup node",
                new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = LookupId, ComparisonColumn = "fullname", ComparisonOperator = ComparisonOperator.IsNotNull },
                LookupId, ReferenceKind.ConditionNodes);
            yield return ConditionCase("condition FieldReference RHS on a lookup node",
                new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = "ownerid", ValueSource = ComparisonValueSource.FieldReference, ComparisonValueNodeId = LookupId, ComparisonValueColumn = "ownerid" },
                LookupId, ReferenceKind.FieldReferenceNodes);
            yield return ConditionCase("condition Template RHS {node:..}",
                new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = "name", ValueSource = ComparisonValueSource.Template, ComparisonValue = $"Hi {{node:{LookupId}.fullname}}" },
                LookupId, ReferenceKind.TemplateNodes, hard: true);
            yield return ConditionCase("condition DateExpression anchor node",
                new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = RootId, ComparisonColumn = "createdon", ValueSource = ComparisonValueSource.DateExpression,
                    ComparisonValue = $"{{\"anchor\":{{\"kind\":\"field\",\"node\":\"{LookupId}\",\"column\":\"birthdate\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}" },
                LookupId, ReferenceKind.DateExprAnchors, hard: true);
            yield return ConditionCase("condition Expression scalar operand",
                new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = RootId, ConditionType = ConditionType.Expression, Expression = $"{{node:{LookupId}.rate}} * 2", ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1" },
                LookupId, ReferenceKind.MathExprScalarNodes, hard: true);
            yield return ConditionCase("condition Expression aggregate operand",
                new RuleCondition { Id = Guid.NewGuid(), TableConfigNodeId = RootId, ConditionType = ConditionType.Expression, Expression = $"sum(node:{ChildId}.amt)", ComparisonOperator = ComparisonOperator.GreaterThan, ComparisonValue = "1" },
                ChildId, ReferenceKind.MathExprAggregateNodes, hard: true);

            yield return FilterCase("ancestor node filter target", ChildId,
                Filter(RootId, new NodeFilterCriterion { FieldName = "name", Operator = "not-null" }), RootId, ReferenceKind.FilterTargetNodes);
            yield return FilterCase("criterion FieldReference value node", ChildId,
                Filter(ChildId, FieldRef(LookupId)), LookupId, ReferenceKind.FilterValueNodes);
            yield return FilterCase("EXISTS over a sibling collection", ChildId,
                Filter(ChildId, Exists(SiblingId)), SiblingId, ReferenceKind.ExistsCollections);
            yield return FilterCase("EXISTS sub-filter FieldReference value node", ChildId,
                Filter(ChildId, Exists(SiblingId, Filter(SiblingId, FieldRef(LookupId)))), LookupId, ReferenceKind.SubFilterNodes);

            var update = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.UpdateRecord, IsActive = true, TargetNodeId = LookupId };
            yield return new Case
            {
                Name = "Update target on an otherwise-unreferenced node",
                Groups = { new ConditionGroup { Id = Guid.NewGuid(), Conditions = { RootCond() } } },
                Actions = { update }, Node = LookupId, Kind = ReferenceKind.ActionTargetNodes, Hard = true,
            };

            yield return MappingCase("mapping node source", new FieldMappingEntry { Target = "a", Source = "node", Node = LookupId, Column = "fullname" }, LookupId, ReferenceKind.MappingSourceNodes);
            yield return MappingCase("mapping ref source", new FieldMappingEntry { Target = "a", Source = "ref", Node = LookupId }, LookupId, ReferenceKind.MappingSourceNodes);
            yield return MappingCase("mapping template token", new FieldMappingEntry { Target = "a", Source = "template", Template = $"{{node:{LookupId}.fullname}}" }, LookupId, ReferenceKind.MappingSourceNodes);
            yield return MappingCase("mapping dateexpr anchor", new FieldMappingEntry { Target = "a", Source = "dateexpr", AnchorKind = "field", AnchorNode = LookupId, AnchorColumn = "birthdate", Op = "add", Amount = 1, Unit = "days" }, LookupId, ReferenceKind.MappingSourceNodes);
            yield return MappingCase("mapping mathexpr scalar", new FieldMappingEntry { Target = "a", Source = "mathexpr", Expression = $"{{node:{LookupId}.rate}} + 1" }, LookupId, ReferenceKind.MappingSourceNodes);
            yield return MappingCase("mapping mathexpr aggregate", new FieldMappingEntry { Target = "a", Source = "mathexpr", Expression = $"sum(node:{ChildId}.amt)" }, ChildId, ReferenceKind.MappingAggregateNodes);
            yield return MappingCase("mapping aggregate filter value node",
                new FieldMappingEntry { Target = "a", Source = "mathexpr", Expression = $"sum(node:{ChildId}.amt filter:f1)", Filters = new Dictionary<string, NodeFilterGroup> { ["f1"] = Filter(ChildId, FieldRef(LookupId)) } },
                LookupId, ReferenceKind.MappingFilterNodes);
            yield return MappingCase("mapping aggregate filter EXISTS collection",
                new FieldMappingEntry { Target = "a", Source = "mathexpr", Expression = $"sum(node:{ChildId}.amt filter:f1)", Filters = new Dictionary<string, NodeFilterGroup> { ["f1"] = Filter(ChildId, Exists(SiblingId)) } },
                SiblingId, ReferenceKind.MappingFilterNodes);

            var block = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.Block, IsActive = true, Message = $"No: {{node:{SiblingId}.name}}" };
            yield return new Case
            {
                Name = "{node:..} message token",
                Groups = { new ConditionGroup { Id = Guid.NewGuid(), Conditions = { RootCond() } } },
                Actions = { block }, Node = SiblingId, Kind = ReferenceKind.MessageNodes, Hard = true, MessageOnly = true,
            };
            var localized = new RuleAction { Id = Guid.NewGuid(), ActionType = ActionType.ShowMessage, IsActive = true, Message = "plain",
                LocalizedMessages = new Dictionary<int, string> { [1036] = $"Non : {{node:{SiblingId}.name}}" } };
            yield return new Case
            {
                Name = "{node:..} localized message token",
                Groups = { new ConditionGroup { Id = Guid.NewGuid(), Conditions = { RootCond() } } },
                Actions = { localized }, Node = SiblingId, Kind = ReferenceKind.MessageNodes, Hard = true, MessageOnly = true,
            };
        }

        public static IEnumerable<object[]> CaseNames() => Cases().Select(c => new object[] { c.Name });

        private static RuleReferences Compute(IEnumerable<Case> cases)
        {
            var all = cases.ToList();
            var mappings = all.SelectMany(c => c.Mappings).ToDictionary(kv => kv.Key, kv => kv.Value);
            return RuleReferences.Compute(
                all.SelectMany(c => c.Groups),
                all.SelectMany(c => c.Actions),
                a => mappings[a.Id]);
        }

        // What RuleValidationLoader hands TableConfigLoader.LoadNodes, and what RunBucket hands
        // TableConfigLoader.LoadConfigs: both (required, optional) pairs read off the same answers.
        private static HashSet<Guid> ValidatorConfigSet(RuleReferences r) => new HashSet<Guid>(r.NodesToLoad.Concat(r.OptionalNodes));
        private static HashSet<Guid> RunnerConfigSeed(RuleReferences r) => new HashSet<Guid>(r.NodesToLoad.Concat(r.OptionalNodes));

        [Theory]
        [MemberData(nameof(CaseNames))]
        public void Every_kind_is_loaded_by_the_validator_whenever_the_runner_seeds_it(string name)
        {
            var c = Cases().Single(x => x.Name == name);
            var refs = Compute(new[] { c });

            Assert.True(ValidatorConfigSet(refs).IsSupersetOf(RunnerConfigSeed(refs)), "validator config set ⊇ runner config seed");
            Assert.True(RunnerConfigSeed(refs).IsSupersetOf(refs.NodesToPlan), "every planned node is a loaded node");
            Assert.Contains(c.Node, RunnerConfigSeed(refs));
            Assert.Contains(c.Node, refs.NodeIds(c.Kind));
            if (c.MessageOnly)
            {
                Assert.Contains(c.Node, refs.OptionalNodes);
                Assert.DoesNotContain(c.Node, refs.NodesToLoad);
            }
            else
            {
                Assert.Contains(c.Node, refs.NodesToLoad);
            }
        }

        [Theory]
        [MemberData(nameof(CaseNames))]
        public void Every_kind_lands_in_exactly_its_own_demand_bucket(string name)
        {
            var c = Cases().Single(x => x.Name == name);
            var refs = Compute(new[] { c });

            Assert.Equal(c.Hard, refs.HardReaders.Contains(c.Node));
            Assert.Equal(c.FilterDerived, refs.FilterDerivedNodes.Contains(c.Node));
            Assert.Equal(c.Hard || c.FilterDerived, refs.NodesToPlan.Contains(c.Node));
            Assert.Equal(c.Hard || c.FilterDerived, refs.Unpruneable.Contains(c.Node));
            // A single-kind rule never puts a node in both buckets.
            Assert.Empty(refs.HardReaders.Intersect(refs.FilterDerivedNodes));
        }

        [Fact]
        public void HardReaders_intersect_FilterDerived_names_only_genuinely_both_nodes()
        {
            // All kinds at once: the lookup node is a hard reader (template / dateexpr / mathexpr /
            // mapping / target) AND a filter-derived node (criterion and sub-filter value node);
            // the sibling is a hard reader (message / aggregate filter EXISTS) AND filter-derived
            // (EXISTS collection). Nothing else may appear in the intersection, because hardReaders
            // is built from its own kind list, never by subtraction.
            var all = Cases().ToList();
            var refs = Compute(all);

            // Every filter case targets the child with its (self) filter group, so the child is
            // filter-derived incidentally, and a hard reader through the aggregate cases.
            var filterDerived = all.Where(c => c.FilterDerived).Select(c => c.Node)
                .Concat(all.SelectMany(c => c.Groups).SelectMany(g => g.NodeFilterGroups).Select(f => f.TableConfigNodeId));
            var expectedBoth = new HashSet<Guid>(all.Where(c => c.Hard).Select(c => c.Node).Intersect(filterDerived));
            Assert.Equal(expectedBoth.OrderBy(x => x), refs.HardReaders.Intersect(refs.FilterDerivedNodes).OrderBy(x => x));
            Assert.Equal(new[] { ChildId, LookupId, SiblingId }.OrderBy(x => x), expectedBoth.OrderBy(x => x));

            Assert.True(ValidatorConfigSet(refs).IsSupersetOf(RunnerConfigSeed(refs)));
            Assert.Empty(refs.OptionalNodes); // the sibling is also structurally referenced here
            foreach (var c in all)
                Assert.Contains(c.Node, refs.NodeIds(c.Kind));
        }
    }
}
