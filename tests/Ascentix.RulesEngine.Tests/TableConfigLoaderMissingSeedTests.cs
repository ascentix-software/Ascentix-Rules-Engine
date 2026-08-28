using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>
    /// A seeded config node that does not come back from the query must be an ERROR, never a
    /// silent omission. The case that reaches this in practice: a rule evaluated against a
    /// config tree whose freshly-created node is not yet visible to this query. Drop the node
    /// and it never enters the plan, QueryExecutor issues no fetch for it, and EvaluateExists
    /// reads an empty cache entry and counts zero, so the rule blocks a save it should have
    /// allowed, with no error anywhere. Fetching fewer nodes than were
    /// asked for is exactly the silently-wrong class the traversal code refuses elsewhere.
    /// </summary>
    public class TableConfigLoaderMissingSeedTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        [Fact]
        public void A_seeded_node_that_does_not_load_throws_instead_of_being_dropped()
        {
            var rootId = Guid.NewGuid();
            var presentChildId = Guid.NewGuid();
            var absentSiblingId = Guid.NewGuid();   // seeded, but no row exists for it

            var root = new Entity(Q(SchemaNames.TableConfig.Entity), rootId)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_order",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            var child = new Entity(Q(SchemaNames.TableConfig.Entity), presentChildId)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "sample_orderline",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.ChildTable),
                [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootId),
                [Q(SchemaNames.TableConfig.ChildLinkField)] = "sample_orderid",
            };

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { root, child });
            var loader = new TableConfigLoader(ctx.GetOrganizationService());

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => loader.LoadConfigs(new object[] { rootId, presentChildId, absentSiblingId }));

            Assert.Contains(absentSiblingId.ToString(), ex.Message);
        }
    }
}
