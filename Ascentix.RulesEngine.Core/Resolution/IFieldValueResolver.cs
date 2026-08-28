using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Resolution
{
    // ─── Field Value Resolver Interface ──────────────────────────────────────

    /// <summary>
    /// Extracts a comparable string value from a Dataverse Entity field,
    /// handling all common Dataverse field types correctly.
    /// </summary>
    public interface IFieldValueResolver
    {
        string ResolveFieldValue(Entity record, string column);
    }
}
