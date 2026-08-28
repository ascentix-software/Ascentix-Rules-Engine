using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class DateExprEvaluatorTests
    {
        static readonly DateTime Now = new DateTime(2026, 1, 31, 12, 0, 0, DateTimeKind.Utc);

        /// <summary>root account → lookup contact (<paramref name="lookupId"/>): the shape a
        /// field-anchored date expression resolves against. A lone parentless lookup is not a
        /// tree the loader accepts (only a Root Table node terminates a chain), so the anchor
        /// tests are homed on a real chain. Their intent is anchor resolution, not cardinality.</summary>
        private static TableConfigTree LookupUnderRoot(Guid lookupId)
        {
            var rootId = Guid.NewGuid();
            return TestTree.Tree(
                TestTree.Node(rootId, "account", TableConfigType.RootTable, null),
                TestTree.Node(lookupId, "contact", TableConfigType.LookupTable, rootId));
        }

        /// <summary>root account → child contact (<paramref name="childId"/>), the 1:many shape
        /// an anchor may never reference.</summary>
        private static TableConfigTree ChildUnderRoot(Guid childId)
        {
            var rootId = Guid.NewGuid();
            return TestTree.Tree(
                TestTree.Node(rootId, "account", TableConfigType.RootTable, null),
                TestTree.Node(childId, "contact", TableConfigType.ChildTable, rootId, "parentcontactid"));
        }

        [Fact]
        public void Now_anchor_add_days()
        {
            var spec = DateExprSpec.Parse("{\"anchor\":{\"kind\":\"now\"},\"op\":\"add\",\"amount\":3,\"unit\":\"days\"}");
            var r = DateExprEvaluator.Evaluate(spec, new Entity("x"), new QueryResultCache(), TableConfigTree.Empty, null, Now, "test");
            Assert.Equal(Now.AddDays(3), r);
        }

        [Fact]
        public void Now_anchor_add_month_clamps_month_end()
        {
            var spec = DateExprSpec.Parse("{\"anchor\":{\"kind\":\"now\"},\"op\":\"add\",\"amount\":1,\"unit\":\"months\"}");
            var r = DateExprEvaluator.Evaluate(spec, new Entity("x"), new QueryResultCache(), TableConfigTree.Empty, null, Now, "test");
            Assert.Equal(new DateTime(2026, 2, 28, 12, 0, 0, DateTimeKind.Utc), r); // Jan31 + 1mo -> Feb28
        }

        [Fact]
        public void Malformed_payload_throws()
            => Assert.Throws<InvalidPluginExecutionException>(() => DateExprSpec.Parse("{\"op\":\"add\"}"));

        [Fact]
        public void Field_anchor_on_root_resolves_via_field_value_resolver()
        {
            // Kind=Unspecified (matches ConditionEvaluatorComparisonTests' date fixtures):
            // the anchor value round-trips through IFieldValueResolver's "o" format, so a
            // Utc-kind source would be converted through the local zone by DateTime.TryParse's
            // DateTimeStyles.None, the same characteristic ConditionEvaluator's existing
            // date-aware comparison already has (both parse resolver-formatted strings with
            // DateTimeStyles.None). Unspecified avoids that conversion so this test is
            // deterministic regardless of the machine's local time zone.
            var spec = DateExprSpec.Parse(
                "{\"anchor\":{\"kind\":\"field\",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":2,\"unit\":\"days\"}");
            var created = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Unspecified);
            var root = new Entity("account") { ["createdon"] = created };

            var r = DateExprEvaluator.Evaluate(spec, root, new QueryResultCache(),
                TableConfigTree.Empty, new FieldValueResolver(), Now, "test");

            Assert.Equal(created.AddDays(2), r);
        }

        [Fact]
        public void Field_anchor_null_on_root_throws()
        {
            var spec = DateExprSpec.Parse(
                "{\"anchor\":{\"kind\":\"field\",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":2,\"unit\":\"days\"}");
            var root = new Entity("account"); // no createdon

            Assert.Throws<InvalidPluginExecutionException>(() =>
                DateExprEvaluator.Evaluate(spec, root, new QueryResultCache(),
                    TableConfigTree.Empty, new FieldValueResolver(), Now, "test"));
        }

        [Fact]
        public void TryEvaluateFromRaw_null_anchor_field_returns_false_not_throw()
        {
            var spec = DateExprSpec.Parse(
                "{\"anchor\":{\"kind\":\"field\",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":2,\"unit\":\"days\"}");
            var root = new Entity("account"); // no createdon

            var ok = DateExprEvaluator.TryEvaluateFromRaw(spec, root, new QueryResultCache(),
                TableConfigTree.Empty, Now, "test", out var result);

            Assert.False(ok);
        }

        [Fact]
        public void TryEvaluateFromRaw_now_anchor_returns_true_and_applies_math()
        {
            var spec = DateExprSpec.Parse("{\"anchor\":{\"kind\":\"now\"},\"op\":\"subtract\",\"amount\":1,\"unit\":\"hours\"}");

            var ok = DateExprEvaluator.TryEvaluateFromRaw(spec, new Entity("x"), new QueryResultCache(),
                TableConfigTree.Empty, Now, "test", out var result);

            Assert.True(ok);
            Assert.Equal(Now.AddHours(-1), result);
        }

        // ── Cardinality policy split: the write side stays lenient (WriteIntentResolver
        // .ReadNodeValue takes records[0] with no >1 check); the condition RHS stays strict
        // (consistent with ComparisonValueResolver's FieldReference guard). ──

        [Fact]
        public void TryEvaluateFromRaw_node_anchor_with_multiple_records_takes_first_no_throw()
        {
            var nodeId = Guid.NewGuid();
            var configs = LookupUnderRoot(nodeId);
            var cache = new QueryResultCache();
            var first = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            cache.Store(nodeId, new List<Entity>
            {
                new Entity("contact") { ["birthdate"] = first },
                new Entity("contact") { ["birthdate"] = new DateTime(2026, 2, 1, 0, 0, 0, DateTimeKind.Utc) },
            });

            var spec = DateExprSpec.Parse(
                $"{{\"anchor\":{{\"kind\":\"field\",\"column\":\"birthdate\",\"node\":\"{nodeId}\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}");

            var ok = DateExprEvaluator.TryEvaluateFromRaw(spec, new Entity("account"), cache, configs, Now, "test", out var result);

            Assert.True(ok);
            Assert.Equal(first.AddDays(1), result); // first record wins, no throw
        }

        [Fact]
        public void Evaluate_node_anchor_with_multiple_records_throws()
        {
            var nodeId = Guid.NewGuid();
            var configs = LookupUnderRoot(nodeId);
            var cache = new QueryResultCache();
            cache.Store(nodeId, new List<Entity>
            {
                new Entity("contact") { ["birthdate"] = new DateTime(2026, 1, 1) },
                new Entity("contact") { ["birthdate"] = new DateTime(2026, 2, 1) },
            });

            var spec = DateExprSpec.Parse(
                $"{{\"anchor\":{{\"kind\":\"field\",\"column\":\"birthdate\",\"node\":\"{nodeId}\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}");

            Assert.Throws<InvalidPluginExecutionException>(() =>
                DateExprEvaluator.Evaluate(spec, new Entity("account"), cache, configs, new FieldValueResolver(), Now, "test"));
        }

        // ── Additional error paths ──
        // Non-DateTime anchor and AliasedValue unwrap only occur in TryEvaluateFromRaw's raw
        // attribute read (Evaluate resolves the anchor via IFieldValueResolver's string
        // round-trip instead, so those two branches are unreachable from Evaluate).

        [Fact]
        public void TryEvaluateFromRaw_non_datetime_anchor_value_throws()
        {
            var root = new Entity("account") { ["createdon"] = "not-a-date" }; // wrong CLR type, not a DateTime
            var spec = DateExprSpec.Parse(
                "{\"anchor\":{\"kind\":\"field\",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":2,\"unit\":\"days\"}");

            Assert.Throws<InvalidPluginExecutionException>(() =>
                DateExprEvaluator.TryEvaluateFromRaw(spec, root, new QueryResultCache(),
                    TableConfigTree.Empty, Now, "test", out var result));
        }

        [Fact]
        public void TryEvaluateFromRaw_aliased_value_anchor_unwraps_before_date_check()
        {
            var nodeId = Guid.NewGuid();
            var configs = LookupUnderRoot(nodeId);
            var anchor = new DateTime(2026, 3, 1, 0, 0, 0, DateTimeKind.Utc);
            var cache = TestTree.Cache((nodeId, new List<Entity>
            {
                TestTree.Row("contact", Guid.NewGuid(),
                    ("birthdate", new AliasedValue("contact", "birthdate", anchor))),
            }));

            var spec = DateExprSpec.Parse(
                $"{{\"anchor\":{{\"kind\":\"field\",\"column\":\"birthdate\",\"node\":\"{nodeId}\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}");

            var ok = DateExprEvaluator.TryEvaluateFromRaw(spec, new Entity("account"), cache, configs, Now, "test", out var result);

            Assert.True(ok);
            Assert.Equal(anchor.AddDays(1), result);
        }

        // Anchor node absent from the config tree and a ChildTable anchor both throw inside the
        // shared ResolveAnchorRecord helper *before* strictCardinality is consulted, so (unlike
        // the zero-cached-records case below) these two do NOT differ between entry points.
        // Both are asserted on both entry points to document that explicitly.

        [Fact]
        public void Evaluate_anchor_node_not_in_config_tree_throws()
        {
            var missingNodeId = Guid.NewGuid();
            var spec = DateExprSpec.Parse(
                $"{{\"anchor\":{{\"kind\":\"field\",\"column\":\"birthdate\",\"node\":\"{missingNodeId}\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}");

            Assert.Throws<InvalidPluginExecutionException>(() =>
                DateExprEvaluator.Evaluate(spec, new Entity("account"), new QueryResultCache(),
                    TableConfigTree.Empty, new FieldValueResolver(), Now, "test"));
        }

        [Fact]
        public void TryEvaluateFromRaw_anchor_node_not_in_config_tree_throws()
        {
            var missingNodeId = Guid.NewGuid();
            var spec = DateExprSpec.Parse(
                $"{{\"anchor\":{{\"kind\":\"field\",\"column\":\"birthdate\",\"node\":\"{missingNodeId}\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}");

            Assert.Throws<InvalidPluginExecutionException>(() =>
                DateExprEvaluator.TryEvaluateFromRaw(spec, new Entity("account"), new QueryResultCache(),
                    TableConfigTree.Empty, Now, "test", out var result));
        }

        [Fact]
        public void Evaluate_child_table_anchor_node_throws()
        {
            var nodeId = Guid.NewGuid();
            var configs = ChildUnderRoot(nodeId);
            var spec = DateExprSpec.Parse(
                $"{{\"anchor\":{{\"kind\":\"field\",\"column\":\"birthdate\",\"node\":\"{nodeId}\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}");

            Assert.Throws<InvalidPluginExecutionException>(() =>
                DateExprEvaluator.Evaluate(spec, new Entity("account"), new QueryResultCache(), configs,
                    new FieldValueResolver(), Now, "test"));
        }

        [Fact]
        public void TryEvaluateFromRaw_child_table_anchor_node_throws()
        {
            var nodeId = Guid.NewGuid();
            var configs = ChildUnderRoot(nodeId);
            var spec = DateExprSpec.Parse(
                $"{{\"anchor\":{{\"kind\":\"field\",\"column\":\"birthdate\",\"node\":\"{nodeId}\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}");

            Assert.Throws<InvalidPluginExecutionException>(() =>
                DateExprEvaluator.TryEvaluateFromRaw(spec, new Entity("account"), new QueryResultCache(), configs,
                    Now, "test", out var result));
        }

        // Zero cached records for the anchor node is the one case that genuinely differs:
        // Evaluate's ResolveFieldAnchor treats the resulting null record as an unparseable
        // anchor field and throws; TryEvaluateFromRaw's ReadRaw treats it as a null attribute
        // and returns false, matching the null-anchor-field behavior tested above. "Zero
        // cached records" means the node was fetched and resolved nothing, so the entry is
        // stored explicitly empty, as the executor would have stored it. (A node that was never
        // fetched at all is a planning fault; the cache read throws for that, as
        // QueryResultCacheTests shows, and these tests must not pass for that reason.)

        [Fact]
        public void Evaluate_anchor_node_zero_cached_records_throws()
        {
            var nodeId = Guid.NewGuid();
            var configs = LookupUnderRoot(nodeId);
            var cache = TestTree.Cache((nodeId, new List<Entity>())); // fetched, matched nothing
            var spec = DateExprSpec.Parse(
                $"{{\"anchor\":{{\"kind\":\"field\",\"column\":\"birthdate\",\"node\":\"{nodeId}\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}");

            var ex = Assert.Throws<InvalidPluginExecutionException>(() =>
                DateExprEvaluator.Evaluate(spec, new Entity("account"), cache, configs, new FieldValueResolver(), Now, "test"));
            Assert.DoesNotContain("planning fault", ex.Message);
        }

        [Fact]
        public void TryEvaluateFromRaw_anchor_node_zero_cached_records_returns_false_not_throw()
        {
            var nodeId = Guid.NewGuid();
            var configs = LookupUnderRoot(nodeId);
            var cache = TestTree.Cache((nodeId, new List<Entity>())); // fetched, matched nothing
            var spec = DateExprSpec.Parse(
                $"{{\"anchor\":{{\"kind\":\"field\",\"column\":\"birthdate\",\"node\":\"{nodeId}\"}},\"op\":\"add\",\"amount\":1,\"unit\":\"days\"}}");

            var ok = DateExprEvaluator.TryEvaluateFromRaw(spec, new Entity("account"), cache, configs, Now, "test", out var result);

            Assert.False(ok);
        }
    }
}
