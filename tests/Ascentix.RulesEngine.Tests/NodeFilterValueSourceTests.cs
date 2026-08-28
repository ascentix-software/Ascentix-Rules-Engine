using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Covers NodeFilterCriterion.ValueSource == FieldReference: the filter RHS is read from a
    /// record in the rule's config tree (root or a single-cardinality node) instead of a literal.
    /// Config/cache scaffolding modeled on ExpressionConditionTests.
    /// </summary>
    public class NodeFilterValueSourceTests
    {
        // Root node ("order") with one ChildTable node ("orderline") holding `amount` rows.
        private static (NodeFilterEvaluator eval, Guid rootNodeId, Guid childNodeId, List<Entity> lines) Setup(
            decimal? rootThreshold, IEnumerable<decimal> lineAmounts)
        {
            var rootNodeId = Guid.NewGuid();
            var childNodeId = Guid.NewGuid();
            var rootNode = new TableConfig
            {
                Id = rootNodeId, TableLogicalName = "order",
                ConfigType = TableConfigType.RootTable,
            };
            var childNode = new TableConfig
            {
                Id = childNodeId, TableLogicalName = "orderline",
                ConfigType = TableConfigType.ChildTable, ParentTableId = rootNodeId,
                ChildLinkField = "parentid",
            };
            var configs = TestTree.Tree(rootNode, childNode);

            var root = new Entity("order", Guid.NewGuid());
            if (rootThreshold.HasValue)
                root["sample_threshold"] = rootThreshold.Value;

            var cache = new QueryResultCache();
            cache.Store(rootNodeId, new List<Entity> { root });

            var lines = new List<Entity>();
            foreach (var amt in lineAmounts)
                lines.Add(new Entity("orderline") { ["amount"] = amt });

            var resolver = new FieldValueResolver();
            var valueResolver = new ComparisonValueResolver(cache, configs, resolver);
            var eval = new NodeFilterEvaluator(resolver, valueResolver);
            return (eval, rootNodeId, childNodeId, lines);
        }

        private static NodeFilterGroup Group(params NodeFilterCriterion[] crit) =>
            new NodeFilterGroup { LogicalOperator = LogicalOperator.And, Criteria = new List<NodeFilterCriterion>(crit) };

        [Fact]
        public void FieldReferenceRhs_ResolvesRootColumn()
        {
            // root order with sample_threshold = 100; line amount 150 gt threshold => match
            var (eval, rootNodeId, _, lines) = Setup(100m, new[] { 150m });
            var criterion = new NodeFilterCriterion
            {
                FieldName = "amount",
                Operator = "gt",
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = rootNodeId,
                ComparisonValueColumn = "sample_threshold",
            };

            Assert.True(eval.EvaluateFilterGroup(Group(criterion), lines));
        }

        [Fact]
        public void FieldReferenceRhs_NoMatchWhenBelowThreshold()
        {
            var (eval, rootNodeId, _, lines) = Setup(100m, new[] { 50m });
            var criterion = new NodeFilterCriterion
            {
                FieldName = "amount",
                Operator = "gt",
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = rootNodeId,
                ComparisonValueColumn = "sample_threshold",
            };

            Assert.False(eval.EvaluateFilterGroup(Group(criterion), lines));
        }

        [Fact]
        public void LiteralRhs_StillWorks_Control()
        {
            var (eval, _, _, lines) = Setup(100m, new[] { 150m });
            var criterion = new NodeFilterCriterion
            {
                FieldName = "amount",
                Operator = "gt",
                Value = "100",
                ValueSource = ComparisonValueSource.Literal,
            };

            Assert.True(eval.EvaluateFilterGroup(Group(criterion), lines));
        }

        [Fact]
        public void FieldReferenceRhs_ZeroRecordsResolvesNull_NoMatch()
        {
            // Reference a node with zero cached records -> ResolveNodeColumn returns null -> no match.
            var rootNodeId = Guid.NewGuid();
            var emptyNodeId = Guid.NewGuid();
            var rootNode = new TableConfig
            {
                Id = rootNodeId, TableLogicalName = "order",
                ConfigType = TableConfigType.RootTable,
            };
            var emptyNode = new TableConfig
            {
                Id = emptyNodeId, TableLogicalName = "orderextra",
                ConfigType = TableConfigType.RootTable,
            };
            var configs = TestTree.Tree(rootNode, emptyNode);

            var cache = new QueryResultCache();
            cache.Store(rootNodeId, new List<Entity> { new Entity("order", Guid.NewGuid()) });
            cache.Store(emptyNodeId, new List<Entity>()); // zero records

            var resolver = new FieldValueResolver();
            var valueResolver = new ComparisonValueResolver(cache, configs, resolver);
            var eval = new NodeFilterEvaluator(resolver, valueResolver);

            var line = new Entity("orderline") { ["amount"] = 150m };
            var criterion = new NodeFilterCriterion
            {
                FieldName = "amount",
                Operator = "gt",
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = emptyNodeId,
                ComparisonValueColumn = "sample_threshold",
            };

            Assert.False(eval.EvaluateFilterGroup(Group(criterion), new List<Entity> { line }));
        }

        [Fact]
        public void FieldReferenceRhs_WithNullValueResolver_Throws()
        {
            var eval = new NodeFilterEvaluator(new FieldValueResolver()); // single-arg ctor, no value resolver
            var criterion = new NodeFilterCriterion
            {
                FieldName = "amount",
                Operator = "gt",
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = Guid.NewGuid(),
                ComparisonValueColumn = "sample_threshold",
            };
            var line = new Entity("orderline") { ["amount"] = 150m };

            Assert.Throws<InvalidPluginExecutionException>(
                () => eval.EvaluateFilterGroup(Group(criterion), new List<Entity> { line }));
        }
    }
}
