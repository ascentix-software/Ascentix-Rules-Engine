using System;
using System.Collections.Generic;
using System.Linq;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class TableConfigLoaderLookupTargetIdTests
    {
        private static string Q(string f) => SchemaNames.Qualify(f);

        [Fact]
        public void Loader_maps_lookuptargetidattribute()
        {
            var rootId = Guid.NewGuid();
            var lookupId = Guid.NewGuid();

            var root = new Entity(Q(SchemaNames.TableConfig.Entity), rootId)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "perf_root",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.RootTable),
            };
            var lookup = new Entity(Q(SchemaNames.TableConfig.Entity), lookupId)
            {
                [Q(SchemaNames.TableConfig.TableLogicalName)] = "perf_lookup1",
                [Q(SchemaNames.TableConfig.TableConfigType)] = new OptionSetValue((int)TableConfigType.LookupTable),
                [Q(SchemaNames.TableConfig.ParentTable)] = new EntityReference(Q(SchemaNames.TableConfig.Entity), rootId),
                [Q(SchemaNames.TableConfig.LookupColumnLogicalName)] = "perf_lookup1id",
                [Q(SchemaNames.TableConfig.LookupTargetIdAttribute)] = "perf_lookup1id",
            };

            var ctx = new XrmFakedContext();
            ctx.Initialize(new List<Entity> { root, lookup });

            var configs = new TableConfigLoader(ctx.GetOrganizationService())
                .LoadConfigs(new object[] { lookupId });

            Assert.Equal("perf_lookup1id", configs.Node(lookupId).LookupTargetIdAttribute);
        }
    }
}
