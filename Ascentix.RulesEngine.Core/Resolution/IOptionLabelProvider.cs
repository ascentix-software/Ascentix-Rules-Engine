namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>Resolves the user-localized label of an enum-type column value (Picklist, State,
    /// Status, multi-select, Boolean) for template rendering. Returns null when unknown so the
    /// caller can fall back to FormattedValues or the raw number.</summary>
    public interface IOptionLabelProvider
    {
        string GetOptionLabel(string table, string column, int value);
    }
}
