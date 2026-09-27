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
            var due = new DateTimeAttributeMetadata { LogicalName = "sample_due", DateTimeBehavior = DateTimeBehavior.DateOnly };
            // AttributeType is read-only; FakeXrmEasy infers it from the concrete metadata type (String).
            var entity = new EntityMetadata { LogicalName = "account" };
            // Attach the attribute via FakeXrmEasy's metadata initialization.
            typeof(EntityMetadata).GetProperty("Attributes").SetValue(entity, new AttributeMetadata[] { attr, due });
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

        // Publish validation reads date behaviors from the same RetrieveEntity data, so the
        // TRAV_PUSHDOWN warning sees the kinds the runtime planner sees.
        [Fact]
        public void Date_behaviors_come_from_the_same_metadata()
        {
            var provider = new AttributeFlagsProvider(WithAccountName().GetOrganizationService());
            Assert.Equal(DateColumnKind.CalendarDate, provider.GetDateKind("account", "sample_due"));
            Assert.Null(provider.GetDateKind("account", "name"));
            Assert.Null(provider.GetDateKind("nosuchtable", "sample_due"));
            Assert.Null(provider.GetDateKind(null, "sample_due"));
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
