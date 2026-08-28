using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// In-flight reconciliation, at the layer it bites: an update action that sums
    /// sample_lineamount across an order's lines, triggered by an update to one of those very
    /// lines. The engine's steps are pre-operation, so the fetch of sample_orderline reads the
    /// line's persisted amount, so without reconciliation the sum is short by (new - old).
    ///
    /// Shape: root sample_orderline → lookup sample_order → child sample_orderline (the
    /// siblings, including the triggering line itself).
    /// </summary>
    public class QueryExecutorInFlightTests
    {
        private static readonly Guid OrderId = Guid.NewGuid();

        private sealed class FakeService : IOrganizationService
        {
            public Func<string, EntityCollection> OnFetch;
            public readonly List<string> Fetches = new List<string>();

            public EntityCollection RetrieveMultiple(QueryBase query)
            {
                var xml = ((FetchExpression)query).Query;
                Fetches.Add(xml);
                return OnFetch(xml);
            }

            public Guid Create(Entity entity) => throw new NotSupportedException();
            public Entity Retrieve(string entityName, Guid id, ColumnSet columnSet) => throw new NotSupportedException();
            public void Update(Entity entity) => throw new NotSupportedException();
            public void Delete(string entityName, Guid id) => throw new NotSupportedException();
            public OrganizationResponse Execute(OrganizationRequest request) => throw new NotSupportedException();
            public void Associate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
            public void Disassociate(string entityName, Guid entityId, Relationship relationship, EntityReferenceCollection relatedEntities) => throw new NotSupportedException();
        }

        private sealed class Tree
        {
            public TableConfigTree Configs;
            public QueryExecutionPlan Plan;
            public Guid LinesNodeId;
        }

        /// <summary>root line → lookup order → child lines.</summary>
        private static Tree BuildTree()
        {
            var rootId = Guid.NewGuid();
            var orderId = Guid.NewGuid();
            var linesId = Guid.NewGuid();

            var configs = TestTree.Tree(
                new TableConfig
                {
                    Id = rootId,
                    TableLogicalName = "sample_orderline",
                    ConfigType = TableConfigType.RootTable,
                },
                new TableConfig
                {
                    Id = orderId,
                    TableLogicalName = "sample_order",
                    ConfigType = TableConfigType.LookupTable,
                    ParentTableId = rootId,
                    LookupColumnLogicalName = "sample_orderid",
                    LookupTargetIdAttribute = "sample_orderid",
                },
                new TableConfig
                {
                    Id = linesId,
                    TableLogicalName = "sample_orderline",
                    ConfigType = TableConfigType.ChildTable,
                    ParentTableId = orderId,
                    ChildLinkField = "sample_orderid",
                }
            );

            var plan = new QueryExecutionPlan();
            plan.Levels.Add(new List<ExecutionPlanEntry>
            {
                new ExecutionPlanEntry { Node = configs.Node(orderId), ParentCacheKey = rootId.ToString() }
            });
            plan.Levels.Add(new List<ExecutionPlanEntry>
            {
                new ExecutionPlanEntry { Node = configs.Node(linesId), ParentCacheKey = orderId.ToString() }
            });

            return new Tree { Configs = configs, Plan = plan, LinesNodeId = linesId };
        }

        private static Entity Line(Guid id, decimal amount)
        {
            var line = new Entity("sample_orderline", id)
            {
                ["sample_lineamount"] = new Money(amount),
                ["sample_orderid"] = new EntityReference("sample_order", OrderId),
            };
            return line;
        }

        private static EntityCollection Collection(params Entity[] entities)
        {
            var col = new EntityCollection();
            foreach (var e in entities) col.Entities.Add(e);
            return col;
        }

        /// <summary>Answers the order fetch, then the sibling-lines fetch with <paramref name="persisted"/>.</summary>
        private static FakeService ServiceFor(IEnumerable<Entity> persisted)
        {
            var rows = persisted.ToList();
            return new FakeService
            {
                OnFetch = xml => xml.Contains("name='sample_order'")
                    ? Collection(new Entity("sample_order", OrderId))
                    : Collection(rows.ToArray())
            };
        }

        private static decimal SumOverNode(Tree tree, QueryResultCache cache)
        {
            var ast = MathExpr.Parse($"sum(node:{tree.LinesNodeId}.sample_lineamount)", "ctx");
            Assert.True(MathExprEvaluator.TryEvaluate(
                ast, new Entity("sample_orderline"), cache, tree.Configs, "ctx", out var sum));
            return sum;
        }

        private static InFlightBatch Batch(InFlightOperation op, Guid id, Entity target, Entity root) =>
            new InFlightBatch
            {
                LogicalName = "sample_orderline",
                Operation = op,
                Records = new List<InFlightRecord>
                {
                    new InFlightRecord { Id = id, Target = target, Root = root }
                }
            };

        [Fact]
        public void Sum_uses_the_updated_amount_not_the_persisted_one()
        {
            var tree = BuildTree();
            var triggeringId = Guid.NewGuid();

            // Persisted: the triggering line at 100, one sibling at 50.
            var service = ServiceFor(new[] { Line(triggeringId, 100m), Line(Guid.NewGuid(), 50m) });

            // In flight: the same line updated to 400.
            var target = new Entity("sample_orderline", triggeringId) { ["sample_lineamount"] = new Money(400m) };
            var root = Line(triggeringId, 400m);

            var cache = new QueryResultCache();
            new QueryExecutor(service, cache, tree.Configs)
                .Execute(root, tree.Plan, Batch(InFlightOperation.Update, triggeringId, target, root));

            Assert.Equal(450m, SumOverNode(tree, cache));   // was 150, the stale persisted 100 + 50
        }

        [Fact]
        public void Sum_counts_a_line_that_is_still_being_created()
        {
            var tree = BuildTree();
            var newId = Guid.NewGuid();

            // Persisted: only the existing sibling; the new line is not in the database yet.
            var service = ServiceFor(new[] { Line(Guid.NewGuid(), 50m) });
            var target = Line(newId, 400m);

            var cache = new QueryResultCache();
            new QueryExecutor(service, cache, tree.Configs)
                .Execute(target, tree.Plan, Batch(InFlightOperation.Create, newId, target, target));

            Assert.Equal(450m, SumOverNode(tree, cache));   // was 50, the new line was invisible
        }

        [Fact]
        public void Sum_stops_counting_a_line_that_is_being_deleted()
        {
            var tree = BuildTree();
            var doomedId = Guid.NewGuid();

            // Persisted: the doomed line still exists at pre-operation.
            var service = ServiceFor(new[] { Line(doomedId, 100m), Line(Guid.NewGuid(), 50m) });
            var root = Line(doomedId, 100m);

            var cache = new QueryResultCache();
            new QueryExecutor(service, cache, tree.Configs)
                .Execute(root, tree.Plan, Batch(InFlightOperation.Delete, doomedId, null, root));

            Assert.Equal(50m, SumOverNode(tree, cache));    // was 150, the doomed line still counted
        }

        [Fact]
        public void A_pushed_filter_that_judged_stale_values_does_not_lose_the_row()
        {
            // The node has a pushed variant; the server applied it to the PERSISTED amount, so
            // the triggering line came back in neither fetch. The row must still be added back:
            // the in-memory filter is the semantic authority over what survives.
            var tree = BuildTree();
            var triggeringId = Guid.NewGuid();
            var linesEntry = tree.Plan.Levels[1][0];
            linesEntry.Variants = new List<NodeQueryVariant>
            {
                new NodeQueryVariant { Key = "amount-gt-100", FilterFetchXml = "<filter />" }
            };

            var sibling = Line(Guid.NewGuid(), 500m);
            var service = new FakeService
            {
                OnFetch = xml => xml.Contains("name='sample_order'")
                    ? Collection(new Entity("sample_order", OrderId))
                    : Collection(sibling)      // both the unfiltered and variant fetch miss it
            };

            var target = new Entity("sample_orderline", triggeringId) { ["sample_lineamount"] = new Money(900m) };
            var root = Line(triggeringId, 900m);

            var cache = new QueryResultCache();
            new QueryExecutor(service, cache, tree.Configs)
                .Execute(root, tree.Plan, Batch(InFlightOperation.Update, triggeringId, target, root));

            Assert.Equal(2, cache.Get(tree.LinesNodeId, "amount-gt-100").Count);
            Assert.Equal(1400m, SumOverNode(tree, cache));
        }

        [Fact]
        public void Without_an_in_flight_operation_results_are_the_persisted_rows()
        {
            var tree = BuildTree();
            var service = ServiceFor(new[] { Line(Guid.NewGuid(), 100m), Line(Guid.NewGuid(), 50m) });

            var cache = new QueryResultCache();
            new QueryExecutor(service, cache, tree.Configs)
                .Execute(Line(Guid.NewGuid(), 0m), tree.Plan);

            Assert.Equal(150m, SumOverNode(tree, cache));
        }
    }
}
