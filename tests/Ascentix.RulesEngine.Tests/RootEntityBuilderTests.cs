using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Execution;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RootEntityBuilderTests
    {
        [Fact]
        public void UseTarget_returns_overlay_unchanged()
        {
            var target = new Entity("account", Guid.NewGuid()) { ["name"] = "Acme" };
            var inputs = new List<RootInput> { new RootInput { Id = target.Id, Overlay = target } };

            var roots = RootEntityBuilder.Build(null, "account", inputs,
                new HashSet<string> { "name" }, RootBuildMode.UseTarget);

            Assert.Single(roots);
            Assert.Equal("Acme", roots[0].GetAttributeValue<string>("name"));
        }

        [Fact]
        public void RetrieveAndOverlay_fills_unchanged_columns_and_lets_target_win()
        {
            var context = new XrmFakedContext();
            var id = Guid.NewGuid();
            context.Initialize(new List<Entity>
            {
                new Entity("account", id) { ["name"] = "Persisted", ["telephone1"] = "555" }
            });
            var svc = context.GetOrganizationService();

            // Target carries only a changed name; telephone1 is unchanged (absent from Target).
            var target = new Entity("account", id) { ["name"] = "Changed" };
            var inputs = new List<RootInput> { new RootInput { Id = id, Overlay = target } };

            var roots = RootEntityBuilder.Build(svc, "account", inputs,
                new HashSet<string> { "name", "telephone1" }, RootBuildMode.RetrieveAndOverlay);

            Assert.Equal("Changed", roots[0].GetAttributeValue<string>("name"));   // overlay wins
            Assert.Equal("555", roots[0].GetAttributeValue<string>("telephone1")); // retrieved
        }

        [Fact]
        public void RetrieveAndOverlay_drops_stale_formatted_value_for_overlaid_column()
        {
            var context = new XrmFakedContext();
            var id = Guid.NewGuid();
            var persisted = new Entity("account", id) { ["revenue"] = new Money(100m) };
            persisted.FormattedValues["revenue"] = "$100.00";
            context.Initialize(new List<Entity> { persisted });
            var svc = context.GetOrganizationService();

            // Target updates revenue to 250; the inbound Target carries no FormattedValues.
            var target = new Entity("account", id) { ["revenue"] = new Money(250m) };
            var inputs = new List<RootInput> { new RootInput { Id = id, Overlay = target } };

            var roots = RootEntityBuilder.Build(svc, "account", inputs,
                new HashSet<string> { "revenue" }, RootBuildMode.RetrieveAndOverlay);

            Assert.Equal(250m, roots[0].GetAttributeValue<Money>("revenue").Value); // raw overlaid
            // The stale retrieved formatting must not survive to mask the new value.
            Assert.False(roots[0].FormattedValues.ContainsKey("revenue"));
        }

        [Fact]
        public void RetrieveAndOverlay_keeps_formatted_value_for_unchanged_column()
        {
            var context = new XrmFakedContext();
            var id = Guid.NewGuid();
            var persisted = new Entity("account", id)
            {
                ["revenue"] = new Money(100m),
                ["name"] = "Persisted",
            };
            persisted.FormattedValues["revenue"] = "$100.00";
            context.Initialize(new List<Entity> { persisted });
            var svc = context.GetOrganizationService();

            var target = new Entity("account", id) { ["name"] = "Changed" };
            var inputs = new List<RootInput> { new RootInput { Id = id, Overlay = target } };

            var roots = RootEntityBuilder.Build(svc, "account", inputs,
                new HashSet<string> { "revenue", "name" }, RootBuildMode.RetrieveAndOverlay);

            // revenue was not overlaid, so its retrieved formatting is still valid.
            Assert.Equal("$100.00", roots[0].FormattedValues["revenue"]);
        }

        [Fact]
        public void RetrieveOnly_returns_persisted_values_in_one_batch()
        {
            var context = new XrmFakedContext();
            var id1 = Guid.NewGuid();
            var id2 = Guid.NewGuid();
            context.Initialize(new List<Entity>
            {
                new Entity("account", id1) { ["name"] = "One" },
                new Entity("account", id2) { ["name"] = "Two" },
            });
            var svc = context.GetOrganizationService();

            var inputs = new List<RootInput>
            {
                new RootInput { Id = id1 },
                new RootInput { Id = id2 },
            };

            var roots = RootEntityBuilder.Build(svc, "account", inputs,
                new HashSet<string> { "name" }, RootBuildMode.RetrieveOnly);

            Assert.Equal(2, roots.Count);
            Assert.Equal("One", roots.Single(r => r.Id == id1).GetAttributeValue<string>("name"));
            Assert.Equal("Two", roots.Single(r => r.Id == id2).GetAttributeValue<string>("name"));
        }

        [Fact]
        public void RetrieveAndOverlay_reports_the_saved_record_before_the_overlay()
        {
            var context = new XrmFakedContext();
            var id = Guid.NewGuid();
            var before = new EntityReference("contact", Guid.NewGuid());
            context.Initialize(new List<Entity> { new Entity("opportunity", id) { ["parentcontactid"] = before } });
            var svc = context.GetOrganizationService();

            var target = new Entity("opportunity", id) { ["parentcontactid"] = new EntityReference("contact", Guid.NewGuid()) };
            var saved = new List<Entity>();
            var roots = RootEntityBuilder.Build(svc, "opportunity", new List<RootInput> { new RootInput { Id = id, Overlay = target } },
                new HashSet<string> { "parentcontactid" }, RootBuildMode.RetrieveAndOverlay, saved: saved);

            Assert.Equal(target.GetAttributeValue<EntityReference>("parentcontactid").Id,
                roots[0].GetAttributeValue<EntityReference>("parentcontactid").Id);
            Assert.Equal(before.Id, Assert.Single(saved).GetAttributeValue<EntityReference>("parentcontactid").Id);
        }

        [Fact]
        public void UseTarget_reports_no_saved_record()
        {
            var target = new Entity("opportunity", Guid.NewGuid());
            var saved = new List<Entity>();
            RootEntityBuilder.Build(null, "opportunity", new List<RootInput> { new RootInput { Id = target.Id, Overlay = target } },
                new HashSet<string>(), RootBuildMode.UseTarget, saved: saved);
            Assert.Null(Assert.Single(saved));
        }

        [Fact]
        public void Assemble_returns_copies_and_never_edits_the_retrieved_rows()
        {
            var id = Guid.NewGuid();
            var persisted = new Entity("account", id) { ["name"] = "Old", ["revenue"] = 10m };
            persisted.FormattedValues["revenue"] = "$10.00";
            var retrieved = new Dictionary<Guid, Entity> { [id] = persisted };
            var inputs = new List<RootInput> { new RootInput { Id = id, Overlay = new Entity("account", id) { ["name"] = "New" } } };

            var a = RootEntityBuilder.Assemble("account", inputs, retrieved, RootBuildMode.RetrieveAndOverlay);
            var b = RootEntityBuilder.Assemble("account", inputs, retrieved, RootBuildMode.RetrieveAndOverlay);

            Assert.Equal("Old", persisted["name"]);
            Assert.NotSame(a[0], b[0]);
            Assert.Equal("New", a[0]["name"]);
            Assert.Equal("$10.00", a[0].FormattedValues["revenue"]);
            a[0]["name"] = "Edited";
            Assert.Equal("New", b[0]["name"]);
        }

        [Fact]
        public void Assemble_shares_one_copy_between_inputs_with_the_same_id()
        {
            var id = Guid.NewGuid();
            var retrieved = new Dictionary<Guid, Entity> { [id] = new Entity("account", id) { ["name"] = "Old" } };
            var inputs = new List<RootInput>
            {
                new RootInput { Id = id, Overlay = new Entity("account", id) { ["name"] = "First" } },
                new RootInput { Id = id, Overlay = new Entity("account", id) { ["description"] = "Second" } },
            };

            var roots = RootEntityBuilder.Assemble("account", inputs, retrieved, RootBuildMode.RetrieveAndOverlay);

            Assert.Same(roots[0], roots[1]);
            Assert.Equal("First", roots[0]["name"]);
            Assert.Equal("Second", roots[0]["description"]);
        }

        [Fact]
        public void Assemble_in_UseTarget_mode_returns_the_targets_themselves()
        {
            var target = new Entity("account", Guid.NewGuid()) { ["name"] = "New" };
            var saved = new List<Entity>();
            var roots = RootEntityBuilder.Assemble("account", new List<RootInput> { new RootInput { Id = target.Id, Overlay = target } },
                null, RootBuildMode.UseTarget, saved);
            Assert.Same(target, roots[0]);
            Assert.Null(Assert.Single(saved));
        }
    }
}
