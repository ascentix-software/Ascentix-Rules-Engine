using System;
using System.Collections.Generic;
using System.Globalization;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// Characterizes TemplateRenderer.FormatValue's branch matrix (multi-select, bool,
    /// AliasedValue, EntityReference, OptionSetValue, and the Money/DateTime invariant-culture
    /// fallbacks). TemplateRendererTests.FakeLabels is private to that class, so this file uses
    /// its own minimal delegate-backed fake rather than duplicating a bespoke one.
    /// </summary>
    public class TemplateRendererFormatTests
    {
        private sealed class FakeLabels : IOptionLabelProvider
        {
            private readonly Func<string, string, int, string> _resolve;
            public FakeLabels(Func<string, string, int, string> resolve) { _resolve = resolve; }
            public string GetOptionLabel(string table, string column, int value) => _resolve(table, column, value);
        }

        private static readonly IOptionLabelProvider NoLabels = new FakeLabels((t, c, v) => null);

        private static (TemplateRenderer renderer, Entity root, QueryResultCache cache) Setup(IOptionLabelProvider labels)
        {
            var rootId = Guid.NewGuid();
            var configs = TestTree.Tree(
                new TableConfig { Id = rootId, TableLogicalName = "account", ConfigType = TableConfigType.RootTable }
            );
            var renderer = new TemplateRenderer(configs, labels);
            var root = new Entity("account", rootId);
            return (renderer, root, new QueryResultCache());
        }

        // ---- OptionSetValueCollection (multi-select) ----

        [Fact]
        public void Multiselect_all_labels_resolve_comma_joins_labels()
        {
            var labels = new FakeLabels((t, c, v) => v == 1 ? "One" : v == 2 ? "Two" : null);
            var (renderer, root, cache) = Setup(labels);
            root["multi"] = new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue(1), new OptionSetValue(2) });

            Assert.Equal("One, Two", renderer.Render("{root.multi}", root, cache, "ctx"));
        }

        [Fact]
        public void Multiselect_any_label_null_falls_back_to_FormattedValues()
        {
            var labels = new FakeLabels((t, c, v) => v == 1 ? "One" : null); // value 2 unresolved
            var (renderer, root, cache) = Setup(labels);
            root["multi"] = new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue(1), new OptionSetValue(2) });
            root.FormattedValues["multi"] = "One, Two (formatted)";

            Assert.Equal("One, Two (formatted)", renderer.Render("{root.multi}", root, cache, "ctx"));
        }

        [Fact]
        public void Multiselect_both_label_and_FormattedValues_missing_falls_back_to_raw_ints()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            root["multi"] = new OptionSetValueCollection(new List<OptionSetValue> { new OptionSetValue(1), new OptionSetValue(2) });

            Assert.Equal("1, 2", renderer.Render("{root.multi}", root, cache, "ctx"));
        }

        [Fact]
        public void Multiselect_empty_collection_renders_empty_string()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            root["multi"] = new OptionSetValueCollection(new List<OptionSetValue>());

            Assert.Equal("", renderer.Render("{root.multi}", root, cache, "ctx"));
        }

        // ---- bool ----

        [Fact]
        public void Bool_uses_option_label_when_resolved()
        {
            var labels = new FakeLabels((t, c, v) => v == 1 ? "Yes" : v == 0 ? "No" : null);
            var (renderer, root, cache) = Setup(labels);
            root["flag"] = true;

            Assert.Equal("Yes", renderer.Render("{root.flag}", root, cache, "ctx"));
        }

        [Fact]
        public void Bool_falls_back_to_FormattedValues_when_no_label()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            root["flag"] = true;
            root.FormattedValues["flag"] = "Enabled";

            Assert.Equal("Enabled", renderer.Render("{root.flag}", root, cache, "ctx"));
        }

        [Theory]
        [InlineData(true, "true")]
        [InlineData(false, "false")]
        public void Bool_falls_back_to_true_false_literal(bool value, string expected)
        {
            var (renderer, root, cache) = Setup(NoLabels);
            root["flag"] = value;

            Assert.Equal(expected, renderer.Render("{root.flag}", root, cache, "ctx"));
        }

        // ---- EntityReference ----

        [Fact]
        public void EntityReference_with_name_renders_name()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            root["lookup"] = new EntityReference("contact", Guid.NewGuid()) { Name = "Sam Roe" };

            Assert.Equal("Sam Roe", renderer.Render("{root.lookup}", root, cache, "ctx"));
        }

        [Fact]
        public void EntityReference_with_null_name_falls_back_to_FormattedValues()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            root["lookup"] = new EntityReference("contact", Guid.NewGuid());
            root.FormattedValues["lookup"] = "Contact #123";

            Assert.Equal("Contact #123", renderer.Render("{root.lookup}", root, cache, "ctx"));
        }

        [Fact]
        public void EntityReference_with_null_name_and_no_FormattedValues_renders_empty_string()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            root["lookup"] = new EntityReference("contact", Guid.NewGuid());

            Assert.Equal("", renderer.Render("{root.lookup}", root, cache, "ctx"));
        }

        // ---- Money / DateTime invariant-culture fallback (no FormattedValues) ----

        [Fact]
        public void Money_without_FormattedValues_uses_invariant_culture_ToString()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            var money = new Money(1234.5m);
            root["revenue"] = money;

            var expected = money.Value.ToString(CultureInfo.InvariantCulture);
            Assert.Equal(expected, renderer.Render("{root.revenue}", root, cache, "ctx"));
        }

        [Fact]
        public void DateTime_without_FormattedValues_uses_invariant_culture_ToString()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            var dt = new DateTime(2024, 3, 15, 10, 30, 0, DateTimeKind.Utc);
            root["created"] = dt;

            var expected = dt.ToString(CultureInfo.InvariantCulture);
            Assert.Equal(expected, renderer.Render("{root.created}", root, cache, "ctx"));
        }

        // ---- OptionSetValue ----

        [Fact]
        public void OptionSetValue_falls_back_to_FormattedValues_when_no_label()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            root["status"] = new OptionSetValue(5);
            root.FormattedValues["status"] = "Pending";

            Assert.Equal("Pending", renderer.Render("{root.status}", root, cache, "ctx"));
        }

        [Fact]
        public void OptionSetValue_falls_back_to_raw_int_when_no_label_or_FormattedValues()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            root["status"] = new OptionSetValue(5);

            Assert.Equal("5", renderer.Render("{root.status}", root, cache, "ctx"));
        }

        // ---- AliasedValue ----

        [Fact]
        public void AliasedValue_is_unwrapped_before_formatting()
        {
            var (renderer, root, cache) = Setup(NoLabels);
            root["x"] = new AliasedValue("othertable", "othercol", "hello");

            Assert.Equal("hello", renderer.Render("{root.x}", root, cache, "ctx"));
        }

        // ---- null root ----

        [Fact]
        public void Null_root_with_root_scoped_segment_renders_empty_string()
        {
            var (renderer, _, cache) = Setup(NoLabels);

            Assert.Equal("", renderer.Render("{root.name}", null, cache, "ctx"));
        }
    }
}
