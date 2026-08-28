using System;
using System.Collections.Generic;
using System.Globalization;
using Ascentix.RulesEngine.Core.Evaluation;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class ComparisonValueResolverTests
    {
        private static readonly DateTime Now = new DateTime(2026, 7, 12, 9, 0, 0, DateTimeKind.Utc);

        private static ComparisonValueResolver Make(QueryResultCache cache, TableConfigTree configs) =>
            new ComparisonValueResolver(cache, configs, new FieldValueResolver(), null, Now);

        [Fact]
        public void Literal_source_returns_the_literal()
        {
            var resolver = Make(new QueryResultCache(), TableConfigTree.Empty);
            var condition = new RuleCondition { ValueSource = ComparisonValueSource.Literal, ComparisonValue = "Valid" };
            Assert.Equal("Valid", resolver.Resolve(condition, new Entity("account"), new Entity("account")));
        }

        [Fact]
        public void Same_record_source_reads_the_column_off_the_lhs_record()
        {
            var resolver = Make(new QueryResultCache(), TableConfigTree.Empty);
            var condition = new RuleCondition
            {
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = null,            // same-record
                ComparisonValueColumn = "actualstart",
            };
            var r = new Entity("appointment") { ["actualstart"] = "2026-01-01" };
            Assert.Equal("2026-01-01", resolver.Resolve(condition, r, r));
        }

        [Fact]
        public void Cross_node_root_source_reads_the_single_cached_root_record()
        {
            var rootId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable }
            );
            var cache = new QueryResultCache();
            var root = new Entity("request") { ["maxprice"] = 500 };
            cache.Store(rootId, new List<Entity> { root });

            var resolver = Make(cache, configs);
            var condition = new RuleCondition
            {
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = rootId,
                ComparisonValueColumn = "maxprice",
            };
            // LHS record is irrelevant for a cross-node ref:
            Assert.Equal("500", resolver.Resolve(condition, new Entity("lineitem"), root));
        }

        [Fact]
        public void Cross_node_with_no_cached_record_resolves_to_null()
        {
            var rootId = Guid.NewGuid();
            var nodeId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = nodeId, ConfigType = TableConfigType.LookupTable, ParentTableId = rootId }
            );
            // The node WAS fetched and resolved nothing (the root's lookup is empty): that is
            // what "no cached record" means. A node that was never fetched is a planning fault
            // and the cache read throws instead. See QueryResultCacheTests.
            var cache = new QueryResultCache();
            cache.Store(nodeId, new List<Entity>());
            var resolver = Make(cache, configs);
            var condition = new RuleCondition
            {
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = nodeId,
                ComparisonValueColumn = "ownerid",
            };
            Assert.Null(resolver.Resolve(condition, new Entity("request"), new Entity("request")));
        }

        [Fact]
        public void Cross_node_under_a_child_hop_is_rejected()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var lookupUnderChildId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, ConfigType = TableConfigType.RootTable },
                new TableConfig { Id = childId, ConfigType = TableConfigType.ChildTable, ParentTableId = rootId },
                new TableConfig
                {
                    Id = lookupUnderChildId, ConfigType = TableConfigType.LookupTable, ParentTableId = childId
                }
            );
            var resolver = Make(new QueryResultCache(), configs);
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = lookupUnderChildId,   // path includes a child hop
                ComparisonValueColumn = "stageid",
            };

            Assert.Throws<InvalidPluginExecutionException>(
                () => resolver.Resolve(condition, new Entity("request"), new Entity("request")));
        }

        [Fact]
        public void Cross_node_referencing_an_unknown_node_throws()
        {
            var resolver = Make(new QueryResultCache(), TableConfigTree.Empty); // empty configs
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ValueSource = ComparisonValueSource.FieldReference,
                ComparisonValueNodeId = Guid.NewGuid(),   // not in configs
                ComparisonValueColumn = "ownerid",
            };

            Assert.Throws<InvalidPluginExecutionException>(
                () => resolver.Resolve(condition, new Entity("request"), new Entity("request")));
        }

        [Fact]
        public void Template_source_renders_against_root()
        {
            var resolver = Make(new QueryResultCache(), TableConfigTree.Empty);
            var root = new Entity("account") { ["name"] = "Acme" };
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ValueSource = ComparisonValueSource.Template,
                ComparisonValue = "Hello {root.name}",
            };

            Assert.Equal("Hello Acme", resolver.Resolve(condition, new Entity("lineitem"), root));
        }

        [Fact]
        public void Template_source_with_unknown_token_throws()
        {
            var resolver = Make(new QueryResultCache(), TableConfigTree.Empty);
            var root = new Entity("account") { ["name"] = "Acme" };
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ValueSource = ComparisonValueSource.Template,
                ComparisonValue = "Hello {bogus.token}",
            };

            Assert.Throws<InvalidPluginExecutionException>(
                () => resolver.Resolve(condition, new Entity("lineitem"), root));
        }

        [Fact]
        public void DateExpression_source_returns_iso_round_trip_string_of_the_computed_date()
        {
            var resolver = Make(new QueryResultCache(), TableConfigTree.Empty);
            var root = new Entity("account");
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ValueSource = ComparisonValueSource.DateExpression,
                ComparisonValue = "{\"anchor\":{\"kind\":\"now\"},\"op\":\"add\",\"amount\":3,\"unit\":\"days\"}",
            };

            var expected = Now.AddDays(3).ToString("o", System.Globalization.CultureInfo.InvariantCulture);
            Assert.Equal(expected, resolver.Resolve(condition, new Entity("lineitem"), root));
        }

        [Fact]
        public void DateExpression_source_with_malformed_payload_throws()
        {
            var resolver = Make(new QueryResultCache(), TableConfigTree.Empty);
            var root = new Entity("account");
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ValueSource = ComparisonValueSource.DateExpression,
                ComparisonValue = "{\"op\":\"add\"}",
            };

            Assert.Throws<InvalidPluginExecutionException>(
                () => resolver.Resolve(condition, new Entity("lineitem"), root));
        }

        // ── Pins ComparisonValueResolver's FIELD-anchor DateExpression output CONTRACT (the ISO
        // round-trip string Resolve() hands back), exercised directly through this file's
        // Make() -> resolver.Resolve() idiom -- not through ConditionEvaluator.
        //
        // The original version of this test asserted a pass/fail outcome through
        // ConditionEvaluator, on the premise that no test closed the loop from a field-anchored
        // DateExpression to ValueComparer's date-aware comparison. That premise was false:
        // ConditionEvaluatorComparisonTests.DateExpression_rhs_field_anchor_flows_through_the_double_round_trip_comparison
        // (commit 37139e4) already covers that loop end-to-end and predates this branch, which
        // made the ConditionEvaluator-based version of this test redundant with it (same table,
        // same field-anchor mechanism, same ordering operator -- differing only in column names
        // and date offsets). What nothing pins directly is the RESOLVER'S OWN output format for
        // this path, independent of ConditionEvaluator/ValueComparer -- that's what this test
        // now covers.
        //
        // Timezone safety: the field-anchor path formats the anchor via FieldValueResolver's "o"
        // format, then re-parses it with DateTime.TryParse(..., DateTimeStyles.None) (see
        // DateExprEvaluator.ResolveFieldAnchor). DateExprEvaluatorTests:38-44 flags that
        // TryParse(..., DateTimeStyles.None) on a "Z"-suffixed ("o"-formatted UTC) string
        // converts it to the local zone (Kind flips Utc -> Local, value shifts by the machine's
        // UTC offset) -- confirmed experimentally: 2026-01-01T00:00:00.0000000Z round-trips to
        // the machine's local wall-clock time, not a literal "...Z" string. A hardcoded expected
        // ISO string would therefore flake across machines/CI images in different time zones.
        // Instead, "expected" is derived by mirroring the same documented recipe (format "o" ->
        // TryParse(None) -> add 30 days -> format "o") using bare DateTime primitives -- not by
        // calling the resolver or DateExprEvaluator under test -- so both sides of the assertion
        // undergo the identical zone conversion and agree regardless of the test machine's local
        // time zone, while still pinning Resolve()'s actual output against that recipe.
        [Fact]
        public void DateExpression_field_anchor_resolves_to_the_format_parse_datemath_format_ISO_string()
        {
            var resolver = Make(new QueryResultCache(), TableConfigTree.Empty);
            var anchor = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc); // root.createdon
            var root = new Entity("account") { ["createdon"] = anchor };
            var condition = new RuleCondition
            {
                Id = Guid.NewGuid(),
                ValueSource = ComparisonValueSource.DateExpression,
                ComparisonValue = "{\"anchor\":{\"kind\":\"field\",\"column\":\"createdon\"},\"op\":\"add\",\"amount\":30,\"unit\":\"days\"}",
            };

            var actual = resolver.Resolve(condition, new Entity("lineitem"), root);

            // Mirror the documented recipe with bare DateTime primitives (not the resolver/
            // DateExprEvaluator under test) so this remains a genuine pin on Resolve()'s output.
            var formattedAnchor = anchor.ToString("o");
            Assert.True(DateTime.TryParse(
                formattedAnchor, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsedAnchor));
            var expected = parsedAnchor.AddDays(30).ToString("o", CultureInfo.InvariantCulture);

            Assert.Equal(expected, actual);
        }
    }
}
