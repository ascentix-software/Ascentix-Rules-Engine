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
    public class TableConfigLoaderTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        [Fact]
        public void Loading_a_node_whose_parent_is_missing_throws_a_config_error_not_a_CLR_error()
        {
            // A valid root exists (so the "no root node" guard passes), but a
            // non-root node's ParentTableId points at a guid that is absent from
            // the loaded set. Before the guard: raw KeyNotFoundException from
            // all[node.ParentTableId.Value]. TableConfigTree.FromLoadedNodes now owns
            // the check (cycles are guarded independently), so this is a safe, non-hanging RED.
            var rootId = Guid.NewGuid();
            var orphanId = Guid.NewGuid();
            var missingParentId = Guid.NewGuid();

            var root = new Entity(Q(SchemaNames.TableConfig.Entity), rootId)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "perf_root",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            var orphan = new Entity(Q(SchemaNames.TableConfig.Entity), orphanId)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "perf_orphan",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), missingParentId),
                [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "perf_orphanid",
                [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "perf_orphanid",
            };

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { root, orphan });

            var loader = new TableConfigLoader(ctx.GetOrganizationService());

            var ex = Assert.Throws<InvalidPluginExecutionException>(
                () => loader.LoadConfigs(new object[] { rootId, orphanId }));

            Assert.Contains("missing", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
