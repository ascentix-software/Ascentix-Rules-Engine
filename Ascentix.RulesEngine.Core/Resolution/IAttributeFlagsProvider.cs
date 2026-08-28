using Microsoft.Xrm.Sdk.Metadata;

namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>Create/update/read validity + type for one column, for the validator's metadata layer.</summary>
    public class AttributeFlags
    {
        public bool IsValidForCreate { get; set; }
        public bool IsValidForUpdate { get; set; }
        public bool IsValidForRead { get; set; }
        public AttributeTypeCode Type { get; set; }
    }

    public interface IAttributeFlagsProvider
    {
        bool TableExists(string table);
        /// <summary>Null when the column does not exist on the table.</summary>
        AttributeFlags GetFlags(string table, string column);
    }
}
