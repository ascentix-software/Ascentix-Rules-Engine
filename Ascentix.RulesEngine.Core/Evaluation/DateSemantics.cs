using System;
using Ascentix.RulesEngine.Core.Execution;
using Ascentix.RulesEngine.Core.Models;
using Ascentix.RulesEngine.Core.Resolution;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Evaluation
{
    /// <summary>One rule's date semantics: each column's behavior (from metadata) and the rule's
    /// evaluation time zone. Plugged into the two comparison points (ConditionEvaluator and
    /// NodeFilterEvaluator); a null answer means "not a date comparison", and the caller keeps
    /// its scalar comparison.</summary>
    public sealed class DateSemantics
    {
        public DateSemantics(IDateColumnKindProvider kinds, TimeZoneInfo zone)
        {
            Kinds = kinds;
            Zone = zone ?? TimeZoneInfo.Utc;
        }

        public IDateColumnKindProvider Kinds { get; }
        public TimeZoneInfo Zone { get; }

        /// <summary>Metadata costs a RetrieveEntity per table, so the column's behavior is read
        /// only once the comparison can take the date path: a comparison operator, a date
        /// comparand, a date value on a record that names its table.</summary>
        public bool? Compare(Entity record, string column, ComparisonOperator op, string comparand)
        {
            if (Kinds == null || record == null || string.IsNullOrEmpty(column) || !record.Contains(column)) return null;
            if (!IsComparison(op) || !PushedDateLiteral.TryParse(comparand, out _, out _)) return null;
            if (string.IsNullOrEmpty(record.LogicalName)) return null;
            var raw = record[column] is AliasedValue aliased ? aliased.Value : record[column];
            if (!(raw is DateTime field)) return null;
            var kind = Kinds.GetDateKind(record.LogicalName, column);
            return kind.HasValue ? DateComparer.Compare(field, kind.Value, op, comparand, Zone) : null;
        }

        /// <summary>The behavior of a date column, for reading a date expression's anchor. Null
        /// when unknown (no table or column, or not a date column).</summary>
        public DateColumnKind? KindOf(string table, string column) =>
            Kinds == null || string.IsNullOrEmpty(table) || string.IsNullOrEmpty(column)
                ? null
                : Kinds.GetDateKind(table, column);

        private static bool IsComparison(ComparisonOperator op) =>
            op == ComparisonOperator.Equals || op == ComparisonOperator.NotEquals
            || op == ComparisonOperator.GreaterThan || op == ComparisonOperator.GreaterThanOrEqual
            || op == ComparisonOperator.LessThan || op == ComparisonOperator.LessThanOrEqual;
    }
}
