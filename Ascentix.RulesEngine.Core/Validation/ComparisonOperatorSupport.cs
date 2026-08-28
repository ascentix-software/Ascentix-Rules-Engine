using System.Collections.Generic;
using Microsoft.Xrm.Sdk.Metadata;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Validation
{
    /// <summary>
    /// Canonical matrix of which ComparisonOperators are meaningful for a column's metadata type.
    /// Single source of truth for the server validator (MetadataChecks) and the documented contract
    /// the editor's TS mirror (operatorSupport.ts) follows. Mirrors the editor's columnKind grouping.
    /// </summary>
    public static class ComparisonOperatorSupport
    {
        private static readonly ComparisonOperator[] Equality =
        {
            ComparisonOperator.Equals, ComparisonOperator.NotEquals,
            ComparisonOperator.IsNull, ComparisonOperator.IsNotNull,
        };

        private static readonly ComparisonOperator[] Ordered =
        {
            ComparisonOperator.Equals, ComparisonOperator.NotEquals,
            ComparisonOperator.GreaterThan, ComparisonOperator.GreaterThanOrEqual,
            ComparisonOperator.LessThan, ComparisonOperator.LessThanOrEqual,
            ComparisonOperator.IsNull, ComparisonOperator.IsNotNull,
        };

        private static readonly ComparisonOperator[] Textual =
        {
            ComparisonOperator.Equals, ComparisonOperator.NotEquals,
            ComparisonOperator.Contains, ComparisonOperator.DoesNotContain,
            ComparisonOperator.IsNull, ComparisonOperator.IsNotNull,
        };

        private static readonly ComparisonOperator[] Numeric =
        {
            ComparisonOperator.Equals, ComparisonOperator.NotEquals,
            ComparisonOperator.GreaterThan, ComparisonOperator.GreaterThanOrEqual,
            ComparisonOperator.LessThan, ComparisonOperator.LessThanOrEqual,
        };

        /// <summary>
        /// Operators valid for an <c>Expression</c> condition, whose LHS is a computed numeric
        /// mathexpr rather than a stored column, keyed by "numeric expression", not an
        /// AttributeTypeCode. No IsNull/IsNotNull (an expression always evaluates to a value or
        /// "no value", never a stored null) and no Contains/DoesNotContain (text-only).
        /// </summary>
        public static IReadOnlyCollection<ComparisonOperator> ForExpression => Numeric;

        public static IReadOnlyCollection<ComparisonOperator> For(AttributeTypeCode type)
        {
            switch (type)
            {
                case AttributeTypeCode.Integer:
                case AttributeTypeCode.BigInt:
                case AttributeTypeCode.Decimal:
                case AttributeTypeCode.Double:
                case AttributeTypeCode.Money:
                case AttributeTypeCode.DateTime:
                    return Ordered;

                case AttributeTypeCode.Boolean:
                case AttributeTypeCode.Picklist:
                case AttributeTypeCode.State:
                case AttributeTypeCode.Status:
                case AttributeTypeCode.Lookup:
                case AttributeTypeCode.Customer:
                case AttributeTypeCode.Owner:
                    return Equality;

                case AttributeTypeCode.String:
                case AttributeTypeCode.Memo:
                case AttributeTypeCode.Virtual: // multi-select optionset
                    return Textual;

                default:
                    return Textual; // unknown → text set (mirrors columnKind fallback)
            }
        }

        public static bool IsAllowed(AttributeTypeCode type, ComparisonOperator op)
        {
            foreach (var allowed in For(type))
                if (allowed == op) return true;
            return false;
        }

        public static bool IsAllowedForExpression(ComparisonOperator op)
        {
            foreach (var allowed in Numeric)
                if (allowed == op) return true;
            return false;
        }
    }
}
