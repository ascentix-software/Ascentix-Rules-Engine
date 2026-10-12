using System;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>The record a Create is inserting, and the run's evaluation instant. At
    /// pre-operation the platform has not stamped createdon/modifiedon yet, so a date expression
    /// anchored on either column of that record reads the evaluation instant instead of null.
    /// Identity is by reference: the executor seeds the root node's cache entry with this same
    /// Entity instance, so a node anchor on the root resolves to it too.</summary>
    public sealed class NewRecordStamp
    {
        public NewRecordStamp(Entity record, DateTime utcNow)
        {
            Record = record;
            UtcNow = utcNow;
        }

        public Entity Record { get; }
        public DateTime UtcNow { get; }

        /// <summary><paramref name="raw"/>, unless it is null, the record is the one being
        /// created, and the column is createdon or modifiedon: then the evaluation instant. A
        /// Create that sets overriddencreatedon has the platform store that value as createdon,
        /// so createdon reads it when present.</summary>
        public static object Fill(NewRecordStamp stamp, Entity record, string column, object raw)
        {
            if (raw != null || stamp == null || record == null || !ReferenceEquals(record, stamp.Record)) return raw;
            if (string.Equals(column, "createdon", StringComparison.OrdinalIgnoreCase))
                return record.GetAttributeValue<DateTime?>("overriddencreatedon") ?? stamp.UtcNow;
            return string.Equals(column, "modifiedon", StringComparison.OrdinalIgnoreCase)
                ? (object)stamp.UtcNow
                : null;
        }
    }
}
