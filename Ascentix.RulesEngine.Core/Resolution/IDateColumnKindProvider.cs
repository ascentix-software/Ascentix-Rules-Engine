namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>How a Dataverse date column stores its value (its DateTimeBehavior).</summary>
    public enum DateColumnKind
    {
        /// <summary>User Local: a UTC instant, in both the date-and-time and date-only formats.</summary>
        Instant = 1,

        /// <summary>Date Only: a calendar date with no time zone.</summary>
        CalendarDate = 2,

        /// <summary>Time Zone Independent: a wall-clock date and time with no time zone.</summary>
        WallClock = 3,
    }

    public interface IDateColumnKindProvider
    {
        /// <summary>Null when the column is not a date column, or is unknown on the table.</summary>
        DateColumnKind? GetDateKind(string table, string column);
    }
}
