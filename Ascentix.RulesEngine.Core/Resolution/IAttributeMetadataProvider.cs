using Microsoft.Xrm.Sdk.Metadata;

namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>Resolves the <see cref="AttributeTypeCode"/> of a table column, for literal
    /// coercion. Returns null when the column does not exist.</summary>
    public interface IAttributeMetadataProvider
    {
        AttributeTypeCode? GetAttributeType(string table, string column);
    }
}
