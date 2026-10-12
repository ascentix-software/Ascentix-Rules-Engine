namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>The default status reason of a table's state, for Deactivate Record.</summary>
    public interface IStatusMetadataProvider
    {
        /// <summary>Null when the table has no statecode, or no status reason for that state.</summary>
        int? GetDefaultStatus(string table, int state);
    }
}
