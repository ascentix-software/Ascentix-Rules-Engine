using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// InFlightReconciler semantics: a pre-operation traversal that re-reads the triggering
    /// table must see the pending operation, not the database state it is about to supersede.
    /// Update overlays, Create adds, Delete drops, and only ever within the scope the fetch
    /// itself covered.
    /// </summary>
    public class InFlightReconcilerTests
    {
        private static readonly Guid OrderId = Guid.NewGuid();
        private static readonly Guid OtherOrderId = Guid.NewGuid();

        private static TableConfig Lines() => new TableConfig
        {
            Id = Guid.NewGuid(),
            TableLogicalName = "sample_orderline",
            ConfigType = TableConfigType.ChildTable,
            ChildLinkField = "sample_orderid",
        };

        private static TableConfig LineLookup() => new TableConfig
        {
            Id = Guid.NewGuid(),
            TableLogicalName = "sample_orderline",
            ConfigType = TableConfigType.LookupTable,
            LookupColumnLogicalName = "sample_priorlineid",
            LookupTargetIdAttribute = "sample_orderlineid",
        };

        private static Entity Line(Guid id, decimal amount, Guid? orderId = null)
        {
            var line = new Entity("sample_orderline", id) { ["sample_lineamount"] = new Money(amount) };
            line["sample_orderid"] = new EntityReference("sample_order", orderId ?? OrderId);
            return line;
        }

        private static InFlightBatch Batch(InFlightOperation op, params InFlightRecord[] records) =>
            new InFlightBatch
            {
                LogicalName = "sample_orderline",
                Operation = op,
                Records = records.ToList()
            };

        private static decimal Sum(IEnumerable<Entity> rows) =>
            rows.Sum(r => r.Contains("sample_lineamount")
                ? ((Money)r["sample_lineamount"]).Value
                : 0m);

        // ── Update ───────────────────────────────────────────────────────────────

        [Fact]
        public void Update_overlays_the_unsaved_value_onto_the_stale_fetched_row()
        {
            var lineId = Guid.NewGuid();
            var rows = new List<Entity> { Line(lineId, 100m), Line(Guid.NewGuid(), 50m) };

            var target = new Entity("sample_orderline", lineId) { ["sample_lineamount"] = new Money(400m) };
            var root = Line(lineId, 400m);
            var inFlight = Batch(InFlightOperation.Update,
                new InFlightRecord { Id = lineId, Target = target, Root = root });

            InFlightReconciler.Apply(rows, Lines(), inFlight, new List<Guid> { OrderId });

            Assert.Equal(2, rows.Count);                       // no row added, it was already there
            Assert.Equal(450m, Sum(rows));                     // 400 (new) + 50, not 150
        }

        [Fact]
        public void Update_adds_the_record_back_when_a_pushed_filter_excluded_it()
        {
            // The server judged `amount > 100` against the STALE 50, so the row never came back.
            var lineId = Guid.NewGuid();
            var rows = new List<Entity> { Line(Guid.NewGuid(), 500m) };

            var root = Line(lineId, 900m);
            var inFlight = Batch(InFlightOperation.Update, new InFlightRecord
            {
                Id = lineId,
                Target = new Entity("sample_orderline", lineId) { ["sample_lineamount"] = new Money(900m) },
                Root = root
            });

            InFlightReconciler.Apply(rows, Lines(), inFlight, new List<Guid> { OrderId });

            Assert.Equal(2, rows.Count);
            Assert.Equal(1400m, Sum(rows));
        }

        [Fact]
        public void Update_drops_the_persisted_formatted_value_it_supersedes()
        {
            var lineId = Guid.NewGuid();
            var row = Line(lineId, 100m);
            row.FormattedValues["sample_lineamount"] = "$100.00";
            var rows = new List<Entity> { row };

            var inFlight = Batch(InFlightOperation.Update, new InFlightRecord
            {
                Id = lineId,
                Target = new Entity("sample_orderline", lineId) { ["sample_lineamount"] = new Money(400m) },
                Root = Line(lineId, 400m)
            });

            InFlightReconciler.Apply(rows, Lines(), inFlight, new List<Guid> { OrderId });

            Assert.False(rows[0].FormattedValues.ContainsKey("sample_lineamount"));
        }

        [Fact]
        public void Update_carries_a_formatted_value_the_target_supplied()
        {
            var lineId = Guid.NewGuid();
            var row = Line(lineId, 100m);
            row.FormattedValues["sample_lineamount"] = "$100.00";
            var rows = new List<Entity> { row };

            var target = new Entity("sample_orderline", lineId) { ["sample_lineamount"] = new Money(400m) };
            target.FormattedValues["sample_lineamount"] = "$400.00";

            InFlightReconciler.Apply(rows, Lines(),
                Batch(InFlightOperation.Update,
                    new InFlightRecord { Id = lineId, Target = target, Root = Line(lineId, 400m) }),
                new List<Guid> { OrderId });

            Assert.Equal("$400.00", rows[0].FormattedValues["sample_lineamount"]);
        }

        // ── Create ───────────────────────────────────────────────────────────────

        [Fact]
        public void Create_adds_the_not_yet_persisted_record_to_the_collection()
        {
            var newId = Guid.NewGuid();
            var rows = new List<Entity> { Line(Guid.NewGuid(), 100m) };

            var target = Line(newId, 250m);
            InFlightReconciler.Apply(rows, Lines(),
                Batch(InFlightOperation.Create,
                    new InFlightRecord { Id = newId, Target = target, Root = target }),
                new List<Guid> { OrderId });

            Assert.Equal(2, rows.Count);
            Assert.Equal(350m, Sum(rows));
        }

        [Fact]
        public void Create_does_not_add_a_record_belonging_to_another_parent()
        {
            var newId = Guid.NewGuid();
            var rows = new List<Entity> { Line(Guid.NewGuid(), 100m) };

            var target = Line(newId, 250m, OtherOrderId);
            InFlightReconciler.Apply(rows, Lines(),
                Batch(InFlightOperation.Create,
                    new InFlightRecord { Id = newId, Target = target, Root = target }),
                new List<Guid> { OrderId });

            Assert.Single(rows);
            Assert.Equal(100m, Sum(rows));
        }

        [Fact]
        public void Create_does_not_add_a_record_whose_parent_link_is_unset()
        {
            var newId = Guid.NewGuid();
            var rows = new List<Entity>();
            var target = new Entity("sample_orderline", newId) { ["sample_lineamount"] = new Money(250m) };

            InFlightReconciler.Apply(rows, Lines(),
                Batch(InFlightOperation.Create,
                    new InFlightRecord { Id = newId, Target = target, Root = target }),
                new List<Guid> { OrderId });

            Assert.Empty(rows);
        }

        [Fact]
        public void Added_rows_are_copies_so_a_later_write_cannot_reach_into_them()
        {
            var newId = Guid.NewGuid();
            var rows = new List<Entity>();
            var target = Line(newId, 250m);

            InFlightReconciler.Apply(rows, Lines(),
                Batch(InFlightOperation.Create,
                    new InFlightRecord { Id = newId, Target = target, Root = target }),
                new List<Guid> { OrderId });

            // A root-in-place UpdateRecord mutates the very Target entity, after evaluation.
            target["sample_lineamount"] = new Money(9999m);

            Assert.NotSame(target, rows[0]);
            Assert.Equal(250m, Sum(rows));
        }

        // ── Delete ───────────────────────────────────────────────────────────────

        [Fact]
        public void Delete_drops_the_doomed_row_from_a_collection()
        {
            var lineId = Guid.NewGuid();
            var rows = new List<Entity> { Line(lineId, 100m), Line(Guid.NewGuid(), 50m) };

            InFlightReconciler.Apply(rows, Lines(),
                Batch(InFlightOperation.Delete,
                    new InFlightRecord { Id = lineId, Target = null, Root = Line(lineId, 100m) }),
                new List<Guid> { OrderId });

            Assert.Single(rows);
            Assert.Equal(50m, Sum(rows));
        }

        [Fact]
        public void Delete_leaves_a_lookup_node_resolving_the_record_being_deleted()
        {
            // A rule may legitimately read the doomed record through a lookup ("block when ...").
            var lineId = Guid.NewGuid();
            var rows = new List<Entity> { Line(lineId, 100m) };

            InFlightReconciler.Apply(rows, LineLookup(),
                Batch(InFlightOperation.Delete,
                    new InFlightRecord { Id = lineId, Target = null, Root = Line(lineId, 100m) }),
                new List<Guid> { lineId });

            Assert.Single(rows);
        }

        // ── Scope and table matching ─────────────────────────────────────────────

        [Fact]
        public void Leaves_a_node_on_a_different_table_untouched()
        {
            var rows = new List<Entity> { new Entity("sample_order", OrderId) { ["sample_total"] = new Money(1m) } };
            var orderNode = new TableConfig
            {
                Id = Guid.NewGuid(),
                TableLogicalName = "sample_order",
                ConfigType = TableConfigType.LookupTable,
            };

            InFlightReconciler.Apply(rows, orderNode,
                Batch(InFlightOperation.Update, new InFlightRecord
                {
                    Id = Guid.NewGuid(),
                    Target = new Entity("sample_orderline") { ["sample_total"] = new Money(777m) },
                    Root = Line(Guid.NewGuid(), 777m)
                }),
                new List<Guid> { OrderId });

            Assert.Single(rows);
            Assert.Equal(1m, ((Money)rows[0]["sample_total"]).Value);
        }

        [Fact]
        public void Lookup_node_overlays_the_unsaved_value_on_the_resolved_record()
        {
            var lineId = Guid.NewGuid();
            var rows = new List<Entity> { Line(lineId, 100m) };

            InFlightReconciler.Apply(rows, LineLookup(),
                Batch(InFlightOperation.Update, new InFlightRecord
                {
                    Id = lineId,
                    Target = new Entity("sample_orderline", lineId) { ["sample_lineamount"] = new Money(400m) },
                    Root = Line(lineId, 400m)
                }),
                new List<Guid> { lineId });

            Assert.Equal(400m, Sum(rows));
        }

        [Fact]
        public void A_batch_reconciles_every_sibling_in_the_same_operation()
        {
            // UpdateMultiple: evaluating one line must see the other unsaved lines too.
            var firstId = Guid.NewGuid();
            var secondId = Guid.NewGuid();
            var rows = new List<Entity> { Line(firstId, 10m), Line(secondId, 20m), Line(Guid.NewGuid(), 5m) };

            InFlightReconciler.Apply(rows, Lines(),
                Batch(InFlightOperation.Update,
                    new InFlightRecord
                    {
                        Id = firstId,
                        Target = new Entity("sample_orderline", firstId) { ["sample_lineamount"] = new Money(100m) },
                        Root = Line(firstId, 100m)
                    },
                    new InFlightRecord
                    {
                        Id = secondId,
                        Target = new Entity("sample_orderline", secondId) { ["sample_lineamount"] = new Money(200m) },
                        Root = Line(secondId, 200m)
                    }),
                new List<Guid> { OrderId });

            Assert.Equal(3, rows.Count);
            Assert.Equal(305m, Sum(rows));
        }

        [Fact]
        public void No_in_flight_operation_leaves_results_alone()
        {
            var rows = new List<Entity> { Line(Guid.NewGuid(), 100m) };
            InFlightReconciler.Apply(rows, Lines(), null, new List<Guid> { OrderId });
            Assert.Equal(100m, Sum(rows));
        }
    }
}
