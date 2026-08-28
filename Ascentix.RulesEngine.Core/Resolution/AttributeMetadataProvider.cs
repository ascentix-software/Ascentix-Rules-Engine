using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;

namespace Ascentix.RulesEngine.Core.Resolution
{
    /// <summary>
    /// Fetches and caches per-table attribute metadata via RetrieveEntityRequest
    /// (EntityFilters.Attributes): column → AttributeTypeCode for literal coercion, and
    /// enum/boolean option labels for template rendering. One retrieve per distinct table for the
    /// lifetime of this instance, so create one per engine invocation.
    /// </summary>
    public class AttributeMetadataProvider : IAttributeMetadataProvider, IOptionLabelProvider
    {
        private readonly IOrganizationService _service;
        private readonly Dictionary<string, Dictionary<string, AttributeTypeCode>> _typeCache =
            new Dictionary<string, Dictionary<string, AttributeTypeCode>>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Dictionary<string, Dictionary<int, string>>> _labelCache =
            new Dictionary<string, Dictionary<string, Dictionary<int, string>>>(StringComparer.OrdinalIgnoreCase);

        public AttributeMetadataProvider(IOrganizationService service) { _service = service; }

        public AttributeTypeCode? GetAttributeType(string table, string column)
        {
            EnsureLoaded(table);
            return _typeCache[table].TryGetValue(column, out var t) ? t : (AttributeTypeCode?)null;
        }

        public string GetOptionLabel(string table, string column, int value)
        {
            EnsureLoaded(table);
            return _labelCache[table].TryGetValue(column, out var opts)
                && opts.TryGetValue(value, out var label) ? label : null;
        }

        private void EnsureLoaded(string table)
        {
            if (_typeCache.ContainsKey(table)) return;

            var resp = (RetrieveEntityResponse)_service.Execute(new RetrieveEntityRequest
            {
                LogicalName = table,
                EntityFilters = EntityFilters.Attributes,
                RetrieveAsIfPublished = true
            });

            var types = new Dictionary<string, AttributeTypeCode>(StringComparer.OrdinalIgnoreCase);
            foreach (var a in resp.EntityMetadata.Attributes)
                if (a.AttributeType.HasValue && !types.ContainsKey(a.LogicalName))
                    types[a.LogicalName] = a.AttributeType.Value;

            var labels = ExtractOptionLabels(resp.EntityMetadata.Attributes);
            _typeCache[table] = types;
            _labelCache[table] = labels;
        }

        /// <summary>Pure label extraction (public static for testability): enum-type attributes
        /// (Picklist/State/Status/multi-select) and Booleans → { column → { value → label } }.</summary>
        public static Dictionary<string, Dictionary<int, string>> ExtractOptionLabels(
            IEnumerable<AttributeMetadata> attributes)
        {
            var map = new Dictionary<string, Dictionary<int, string>>(StringComparer.OrdinalIgnoreCase);
            foreach (var a in attributes)
            {
                switch (a)
                {
                    case EnumAttributeMetadata en when en.OptionSet != null && en.OptionSet.Options != null:
                        var opts = new Dictionary<int, string>();
                        foreach (var o in en.OptionSet.Options.Where(o => o.Value.HasValue))
                            opts[o.Value.Value] = o.Label?.UserLocalizedLabel?.Label;
                        map[a.LogicalName] = opts;
                        break;
                    case BooleanAttributeMetadata b when b.OptionSet != null:
                        map[a.LogicalName] = new Dictionary<int, string>
                        {
                            [0] = b.OptionSet.FalseOption?.Label?.UserLocalizedLabel?.Label,
                            [1] = b.OptionSet.TrueOption?.Label?.UserLocalizedLabel?.Label,
                        };
                        break;
                }
            }
            return map;
        }
    }
}
