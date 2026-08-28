using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class TemplateRendererTests
    {
        private sealed class FakeLabels : IOptionLabelProvider
        {
            public string GetOptionLabel(string table, string column, int value) =>
                table == "account" && column == "statuscode" && value == 1 ? "Open" : null;
        }

        private static (TemplateRenderer renderer, Guid rootId, Guid lookupId, QueryResultCache cache) Setup()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();
            var tree = TestTree.Tree(
                TestTree.Node(rootId, "account", TableConfigType.RootTable, null),
                TestTree.Node(lookupId, "contact", TableConfigType.LookupTable, rootId));
            return (new TemplateRenderer(tree, new FakeLabels()), rootId, lookupId, new QueryResultCache());
        }

        [Fact]
        public void Tokenize_splits_literals_tokens_and_escapes()
        {
            var segs = TemplateRenderer.Tokenize("a {{b}} {root.name} c", "ctx");
            Assert.True(segs[0].IsLiteral);
            Assert.Equal("a {b} ", segs[0].Text);
            Assert.False(segs[1].IsLiteral);
            Assert.Null(segs[1].Node);
            Assert.Equal("name", segs[1].Column);
            Assert.Equal(" c", segs[2].Text);
        }

        [Fact]
        public void Tokenize_parses_node_tokens()
        {
            var id = Guid.NewGuid();
            var segs = TemplateRenderer.Tokenize($"{{node:{id}.fullname}}", "ctx");
            Assert.Equal(id, segs[0].Node);
            Assert.Equal("fullname", segs[0].Column);
        }

        [Theory]
        [InlineData("{oops.name}")]      // unknown prefix
        [InlineData("{root.}")]          // missing column
        [InlineData("{node:nope.col}")]  // bad guid
        [InlineData("open { brace")]     // unclosed
        [InlineData("stray } brace")]    // stray close
        public void Tokenize_rejects_malformed_templates(string template)
        {
            Assert.Throws<InvalidPluginExecutionException>(() => TemplateRenderer.Tokenize(template, "ctx"));
        }

        [Fact]
        public void Renders_root_and_node_values_with_labels_and_names()
        {
            var (renderer, rootId, lookupId, cache) = Setup();
            var root = new Entity("account", rootId)
            {
                ["name"] = "Acme",
                ["statuscode"] = new OptionSetValue(1),
                ["ownerid"] = new EntityReference("systemuser", Guid.NewGuid()) { Name = "Pat Lee" },
            };
            var contact = new Entity("contact", Guid.NewGuid()) { ["fullname"] = "Sam Roe" };
            cache.Store(lookupId, new List<Entity> { contact });

            var text = renderer.Render(
                $"{{root.name}} ({{root.statuscode}}) owner {{root.ownerid}} — {{node:{lookupId}.fullname}}",
                root, cache, "ctx");

            Assert.Equal("Acme (Open) owner Pat Lee — Sam Roe", text);
        }

        [Fact]
        public void Null_and_missing_values_render_empty()
        {
            var (renderer, rootId, lookupId, cache) = Setup();
            var root = new Entity("account", rootId);
            cache.Store(lookupId, new List<Entity>()); // zero node records

            var text = renderer.Render($"[{{root.name}}][{{node:{lookupId}.fullname}}]", root, cache, "ctx");
            Assert.Equal("[][]", text);
        }

        [Fact]
        public void Formatted_values_beat_invariant_tostring()
        {
            var (renderer, rootId, _, cache) = Setup();
            var root = new Entity("account", rootId) { ["revenue"] = new Money(1234.5m) };
            root.FormattedValues["revenue"] = "$1,234.50";

            Assert.Equal("$1,234.50", renderer.Render("{root.revenue}", root, cache, "ctx"));
        }

        [Fact]
        public void Unknown_node_and_multi_record_node_throw()
        {
            var (renderer, rootId, lookupId, cache) = Setup();
            var root = new Entity("account", rootId);
            Assert.Throws<InvalidPluginExecutionException>(() =>
                renderer.Render($"{{node:{Guid.NewGuid()}.x}}", root, cache, "ctx"));

            cache.Store(lookupId, new List<Entity> { new Entity("contact"), new Entity("contact") });
            Assert.Throws<InvalidPluginExecutionException>(() =>
                renderer.Render($"{{node:{lookupId}.fullname}}", root, cache, "ctx"));
        }

        [Fact]
        public void Child_node_token_throws()
        {
            var rootId = Guid.NewGuid();
            var childId = Guid.NewGuid();
            var tree = TestTree.Tree(
                TestTree.Node(rootId, "account", TableConfigType.RootTable, null),
                TestTree.Node(childId, "task", TableConfigType.ChildTable, rootId));
            var renderer = new TemplateRenderer(tree, new FakeLabels());
            Assert.Throws<InvalidPluginExecutionException>(() =>
                renderer.Render($"{{node:{childId}.subject}}", new Entity("account", rootId), new QueryResultCache(), "ctx"));
        }

        [Fact]
        public void Null_template_throws_a_config_error_not_a_NullReferenceException()
        {
            var (renderer, rootId, _, cache) = Setup();
            var root = new Entity("account", rootId);

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => renderer.Render(null, root, cache, "condition X"));
            Assert.Contains("condition X", ex.Message);
        }

        [Fact]
        public void Empty_or_whitespace_template_renders_as_empty_string()
        {
            var (renderer, rootId, _, cache) = Setup();
            var root = new Entity("account", rootId);

            Assert.Equal("", renderer.Render("", root, cache, "ctx"));
            Assert.Equal("   ", renderer.Render("   ", root, cache, "ctx"));
        }
    }
}
