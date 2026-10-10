using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Plugin;
using Ascentix.RulesEngine.Schema;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    // asx_BulkWrites: bulk messages only while an administrator has turned the switch on. Microsoft
    // doesn't support bulk messages in plug-in code, so it ships off and every write goes single.
    public class BulkWritesSwitchTests
    {
        private static readonly Guid Org = Guid.NewGuid();
        private DateTime _now = new DateTime(2026, 10, 9, 12, 0, 0, DateTimeKind.Utc);

        private static IOrganizationService Service(string defaultValue, string value)
        {
            var definition = new Entity("environmentvariabledefinition", Guid.NewGuid())
            {
                ["schemaname"] = SchemaNames.Qualify(SchemaNames.EnvironmentVariables.BulkWrites),
            };
            if (defaultValue != null) definition["defaultvalue"] = defaultValue;
            var seed = new List<Entity> { definition };
            if (value != null)
                seed.Add(new Entity("environmentvariablevalue", Guid.NewGuid())
                {
                    ["environmentvariabledefinitionid"] = definition.ToEntityReference(),
                    ["value"] = value,
                    ["statecode"] = new OptionSetValue(0),
                });
            var ctx = new XrmFakedContext();
            ctx.Initialize(seed);
            return ctx.GetOrganizationService();
        }

        private EnvironmentSwitch Switch() =>
            new EnvironmentSwitch(SchemaNames.EnvironmentVariables.BulkWrites, "asx_BulkWrites", () => _now);

        [Theory]
        [InlineData("no", null)]          // the shipped default
        [InlineData("no", "no")]
        [InlineData("yes", "no")]         // a value overrides the default
        [InlineData(null, null)]          // no default: off
        public void Off_answers_every_table_as_not_bulk(string defaultValue, string value)
        {
            var support = BulkWrites.Support(Switch(), Service(defaultValue, value), Org, null);
            Assert.Same(NoBulkSupport.Instance, support);
            Assert.False(support.Supports("UpdateMultiple", "contact"));
        }

        [Theory]
        [InlineData("no", "yes")]
        [InlineData("yes", null)]
        public void On_asks_the_table(string defaultValue, string value)
        {
            Assert.IsType<SdkMessageFilterBulkSupport>(BulkWrites.Support(Switch(), Service(defaultValue, value), Org, null));
        }

        [Fact]
        public void Missing_definition_counts_as_off()
        {
            var ctx = new XrmFakedContext();
            Assert.Same(NoBulkSupport.Instance, BulkWrites.Support(Switch(), ctx.GetOrganizationService(), Org, null));
        }

        [Fact]
        public void A_reading_is_kept_for_a_minute_then_read_again()
        {
            var bulkSwitch = Switch();
            var on = Service("no", "yes");
            Assert.True(bulkSwitch.IsOn(on, Org, null));
            Assert.True(bulkSwitch.IsOn(Service("no", "no"), Org, null)); // cached
            _now = _now.Add(EnvironmentSwitch.Lifetime);
            Assert.False(bulkSwitch.IsOn(Service("no", "no"), Org, null));
        }
    }
}
