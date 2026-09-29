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
    /// enum/boolean option labels for template rendering, and date column behaviors. One retrieve
    /// per distinct table for the lifetime of this instance: RulesEngineRunner creates one per run
    /// and shares it across every bucket.
    /// </summary>
    public class AttributeMetadataProvider : IAttributeMetadataProvider, IOptionLabelProvider, IDateColumnKindProvider, IStatusMetadataProvider
    {
        private readonly IOrganizationService _service;
        private readonly Dictionary<string, Dictionary<string, AttributeTypeCode>> _typeCache =
            new Dictionary<string, Dictionary<string, AttributeTypeCode>>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Dictionary<string, Dictionary<int, string>>> _labelCache =
            new Dictionary<string, Dictionary<string, Dictionary<int, string>>>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Dictionary<string, DateColumnKind>> _kindCache =
            new Dictionary<string, Dictionary<string, DateColumnKind>>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Dictionary<int, int>> _statusCache =
            new Dictionary<string, Dictionary<int, int>>(StringComparer.OrdinalIgnoreCase);

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

        public DateColumnKind? GetDateKind(string table, string column)
        {
            if (string.IsNullOrEmpty(table) || string.IsNullOrEmpty(column)) return null;
            EnsureLoaded(table);
            return _kindCache[table].TryGetValue(column, out var k) ? k : (DateColumnKind?)null;
        }

        public int? GetDefaultStatus(string table, int state)
        {
            if (string.IsNullOrEmpty(table)) return null;
            EnsureLoaded(table);
            return _statusCache[table].TryGetValue(state, out var status) ? status : (int?)null;
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

            var kinds = new Dictionary<string, DateColumnKind>(StringComparer.OrdinalIgnoreCase);
            foreach (var a in resp.EntityMetadata.Attributes)
                if (KindOf(a) is DateColumnKind kind && !kinds.ContainsKey(a.LogicalName))
                    kinds[a.LogicalName] = kind;

            var labels = ExtractOptionLabels(resp.EntityMetadata.Attributes);
            _statusCache[table] = DefaultStatuses(resp.EntityMetadata.Attributes);
            _typeCache[table] = types;
            _labelCache[table] = labels;
            _kindCache[table] = kinds;
        }

        /// <summary>state → default status reason (public static for testability): a state option's
        /// DefaultStatus, else the first status option of that state.</summary>
        public static Dictionary<int, int> DefaultStatuses(IEnumerable<AttributeMetadata> attributes)
        {
            var result = new Dictionary<int, int>();
            var list = attributes?.ToList() ?? new List<AttributeMetadata>();
            foreach (var option in list.OfType<StateAttributeMetadata>().Where(a => a.OptionSet?.Options != null)
                         .SelectMany(a => a.OptionSet.Options.OfType<StateOptionMetadata>()))
                if (option.Value.HasValue && option.DefaultStatus.HasValue) result[option.Value.Value] = option.DefaultStatus.Value;
            foreach (var option in list.OfType<StatusAttributeMetadata>().Where(a => a.OptionSet?.Options != null)
                         .SelectMany(a => a.OptionSet.Options.OfType<StatusOptionMetadata>()))
                if (option.State.HasValue && option.Value.HasValue && !result.ContainsKey(option.State.Value))
                    result[option.State.Value] = option.Value.Value;
            return result;
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

        /// <summary>The comparison kind of a date column (public static for testability): Date
        /// Only → CalendarDate, Time Zone Independent → WallClock, User Local (or no behavior
        /// reported) → Instant. Null for any other attribute type.</summary>
        public static DateColumnKind? KindOf(AttributeMetadata a)
        {
            if (!(a is DateTimeAttributeMetadata dt)) return null;
            var behavior = dt.DateTimeBehavior?.Value;
            if (behavior == DateTimeBehavior.DateOnly.Value) return DateColumnKind.CalendarDate;
            if (behavior == DateTimeBehavior.TimeZoneIndependent.Value) return DateColumnKind.WallClock;
            return DateColumnKind.Instant;
        }
    }
}
