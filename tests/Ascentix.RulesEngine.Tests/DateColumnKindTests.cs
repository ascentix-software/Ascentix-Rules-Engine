using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk.Metadata;
using Xunit;

namespace Ascentix.RulesEngine.Tests
{
    public class DateColumnKindTests
    {
        private static readonly DateTimeBehavior[] Behaviors =
            { DateTimeBehavior.UserLocal, DateTimeBehavior.DateOnly, DateTimeBehavior.TimeZoneIndependent };

        [Theory]
        [InlineData(0, DateColumnKind.Instant)]
        [InlineData(1, DateColumnKind.CalendarDate)]
        [InlineData(2, DateColumnKind.WallClock)]
        public void Date_behavior_maps_to_a_kind(int behavior, DateColumnKind expected)
        {
            var a = new DateTimeAttributeMetadata { LogicalName = "d", DateTimeBehavior = Behaviors[behavior] };
            Assert.Equal(expected, AttributeMetadataProvider.KindOf(a));
        }

        [Fact]
        public void A_date_column_without_a_behavior_is_an_instant()
        {
            Assert.Equal(DateColumnKind.Instant, AttributeMetadataProvider.KindOf(new DateTimeAttributeMetadata { LogicalName = "d" }));
        }

        [Fact]
        public void A_non_date_column_has_no_kind()
        {
            Assert.Null(AttributeMetadataProvider.KindOf(new StringAttributeMetadata { LogicalName = "s" }));
        }
    }
}
