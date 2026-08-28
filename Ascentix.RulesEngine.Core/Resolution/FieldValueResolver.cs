using System;
using System.Globalization;
using System.Linq;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Resolution
{
    public class FieldValueResolver : IFieldValueResolver
    {
        public string ResolveFieldValue(Entity record, string column)
        {
            if (!record.Contains(column) || record[column] == null)
                return null;

            return record[column] switch
            {
                OptionSetValueCollection multiSelect =>
                    string.Join(",", multiSelect.Select(o => o.Value.ToString())),
                OptionSetValue optionSet =>
                    optionSet.Value.ToString(),
                EntityReference entityRef =>
                    entityRef.Id.ToString(),
                Money money =>
                    money.Value.ToString(CultureInfo.InvariantCulture),
                DateTime dateTime =>
                    dateTime.ToString("o"),
                bool boolean =>
                    boolean.ToString().ToLowerInvariant(),
                AliasedValue aliased =>
                    ResolveAliasedValue(aliased),
                _ =>
                    record[column].ToString()
            };
        }

        private string ResolveAliasedValue(AliasedValue aliased)
        {
            return aliased.Value switch
            {
                OptionSetValue optionSet =>
                    optionSet.Value.ToString(),
                EntityReference entityRef =>
                    entityRef.Id.ToString(),
                Money money =>
                    money.Value.ToString(CultureInfo.InvariantCulture),
                DateTime dateTime =>
                    dateTime.ToString("o"),
                bool boolean =>
                    boolean.ToString().ToLowerInvariant(),
                _ =>
                    aliased.Value?.ToString()
            };
        }
    }
}
