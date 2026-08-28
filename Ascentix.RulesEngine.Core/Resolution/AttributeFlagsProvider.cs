using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;

namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>
    /// Fetches and caches per-table attribute metadata (create/update/read flags + type) via
    /// RetrieveEntityRequest. One retrieve per distinct table for this instance's lifetime.
    /// </summary>
    public class AttributeFlagsProvider : IAttributeFlagsProvider
    {
        private readonly IOrganizationService _service;
        private readonly Dictionary<string, Dictionary<string, AttributeFlags>> _cache =
            new Dictionary<string, Dictionary<string, AttributeFlags>>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _missingTables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public AttributeFlagsProvider(IOrganizationService service) { _service = service; }

        public bool TableExists(string table) => Load(table) != null;

        public AttributeFlags GetFlags(string table, string column)
        {
            var cols = Load(table);
            if (cols == null) return null;
            return cols.TryGetValue(column, out var f) ? f : null;
        }

        private Dictionary<string, AttributeFlags> Load(string table)
        {
            if (string.IsNullOrWhiteSpace(table)) return null;
            if (_cache.TryGetValue(table, out var cached)) return cached;
            if (_missingTables.Contains(table)) return null;

            EntityMetadata md;
            try
            {
                var resp = (RetrieveEntityResponse)_service.Execute(new RetrieveEntityRequest
                {
                    LogicalName = table,
                    EntityFilters = EntityFilters.Attributes,
                    RetrieveAsIfPublished = true
                });
                md = resp.EntityMetadata;
            }
            catch (Exception)
            {
                _missingTables.Add(table); // unknown table → treated as non-existent
                return null;
            }

            var map = new Dictionary<string, AttributeFlags>(StringComparer.OrdinalIgnoreCase);
            foreach (var a in md.Attributes)
            {
                if (a.LogicalName == null || map.ContainsKey(a.LogicalName)) continue;
                map[a.LogicalName] = new AttributeFlags
                {
                    IsValidForCreate = a.IsValidForCreate ?? true,
                    IsValidForUpdate = a.IsValidForUpdate ?? true,
                    IsValidForRead = a.IsValidForRead ?? true,
                    Type = a.AttributeType ?? AttributeTypeCode.String
                };
            }
            _cache[table] = map;
            return map;
        }
    }
}
