using Ascentix.RulesEngine.Core;
using Ascentix.RulesEngine.Core.Loaders;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class RuleLoaderSmokeTests
    {
        [Fact]
        public void LoadRules_against_empty_org_returns_no_rules()
        {
            var context = new XrmFakedContext();
            var service = context.GetOrganizationService();

            var loader = new RuleLoader(service);
            var rules = loader.LoadRules("account");

            Assert.Empty(rules);
        }

        [Fact]
        public void TableConfigLoader_constructs_against_empty_org()
        {
            // Plan 2B: full query test with seeded metadata.
            // TableConfigLoader.LoadConfigs throws an InvalidPluginExecutionException
            // when no Root Table config exists (its tree-root guard), so an empty-org
            // query path cannot be exercised here. The smoke goal is only to prove the
            // renamed type instantiates and links against the engine assembly.
            var context = new XrmFakedContext();
            var service = context.GetOrganizationService();

            var loader = new TableConfigLoader(service);

            Assert.NotNull(loader);
        }

        [Fact]
        public void Engine_qualifies_config_names_to_the_asx_schema()
        {
            // Guards the backfill end-to-end: the engine builds names from the shared
            // fragments under the shipped prefix.
            Assert.Equal("asx_rule", SchemaNames.Qualify(SchemaNames.Rule.Entity));
            Assert.Equal("asx_tableconfig", SchemaNames.Qualify(SchemaNames.TableConfig.Entity));
        }
    }
}
