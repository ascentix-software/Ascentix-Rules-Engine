using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Resolution;
using FakeXrmEasy;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class AttributeFlagsProviderTests
    {
        private static XrmFakedContext WithAccountName()
        {
            var attr = new StringAttributeMetadata { LogicalName = "name" };
            // AttributeType is read-only; FakeXrmEasy infers it from the concrete metadata type (String).
            var entity = new EntityMetadata { LogicalName = "account" };
            // Attach the attribute via FakeXrmEasy's metadata initialization.
            typeof(EntityMetadata).GetProperty("Attributes").SetValue(entity, new AttributeMetadata[] { attr });
            var ctx = new XrmFakedContext();
            ctx.InitializeMetadata(new List<EntityMetadata> { entity });
            return ctx;
        }

        [Fact]
        public void Existing_column_returns_flags()
        {
            var ctx = WithAccountName();
            var provider = new AttributeFlagsProvider(ctx.GetOrganizationService());
            var flags = provider.GetFlags("account", "name");
            Assert.NotNull(flags);
        }

        [Fact]
        public void Missing_column_returns_null()
        {
            var ctx = WithAccountName();
            var provider = new AttributeFlagsProvider(ctx.GetOrganizationService());
            Assert.Null(provider.GetFlags("account", "doesnotexist"));
        }

        [Fact]
        public void Table_exists_reports_true_for_known_table()
        {
            var ctx = WithAccountName();
            var provider = new AttributeFlagsProvider(ctx.GetOrganizationService());
            Assert.True(provider.TableExists("account"));
        }
    }
}
