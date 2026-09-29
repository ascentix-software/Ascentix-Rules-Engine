using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>
    /// The change set's no-op comparison: does a written value equal the value the row already
    /// holds? Normalizes Money ↔ decimal, OptionSetValue ↔ int (all whole numbers as decimal),
    /// OptionSetValueCollection as a set (empty ≡ null), EntityReference by id (and table when
    /// both name one), DateTime in UTC (unspecified = UTC), "" ≡ null, strings ordinal.
    /// </summary>
    public static class WriteValueComparer
    {
        public static bool AreEqual(object written, object loaded)
        {
            var a = Normalize(written);
            var b = Normalize(loaded);
            if (a == null || b == null) return a == null && b == null;

            if (a is EntityReference ra && b is EntityReference rb)
                return ra.Id == rb.Id
                    && (string.IsNullOrEmpty(ra.LogicalName) || string.IsNullOrEmpty(rb.LogicalName)
                        || string.Equals(ra.LogicalName, rb.LogicalName, StringComparison.OrdinalIgnoreCase));
            if (a is HashSet<int> sa && b is HashSet<int> sb) return sa.SetEquals(sb);
            if (a is string s1 && b is string s2) return string.Equals(s1, s2, StringComparison.Ordinal);
            if ((a is decimal && b is double) || (a is double && b is decimal))
                return Convert.ToDouble(a) == Convert.ToDouble(b);
            return a.Equals(b);
        }

        private static object Normalize(object value)
        {
            switch (value)
            {
                case null: return null;
                case AliasedValue aliased: return Normalize(aliased.Value);
                case Money money: return money.Value;
                case OptionSetValue option: return (decimal)option.Value;
                case int i: return (decimal)i;
                case long l: return (decimal)l;
                case OptionSetValueCollection options:
                    return options.Count == 0 ? null : new HashSet<int>(options.Select(o => o.Value));
                case DateTime dt:
                    return dt.Kind == DateTimeKind.Local ? dt.ToUniversalTime() : DateTime.SpecifyKind(dt, DateTimeKind.Utc);
                case string s:
                    return s.Length == 0 ? null : s;
                default:
                    return value;
            }
        }
    }
}
