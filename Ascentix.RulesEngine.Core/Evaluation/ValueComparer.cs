using System;
using System.Globalization;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Evaluation
{
    /// <summary>Scalar comparison shared by ConditionEvaluator and NodeFilterEvaluator so their
    /// numeric/date/string semantics never diverge. Numeric if both parse as decimal; else date
    /// if both parse as DateTime (invariant); else string (ordinal, case-insensitive).</summary>
    public static class ValueComparer
    {
        public static bool CompareScalar(string actual, ComparisonOperator op, string expected)
        {
            if (decimal.TryParse(actual, out var an) && decimal.TryParse(expected, out var en))
            {
                switch (op)
                {
                    case ComparisonOperator.Equals: return an == en;
                    case ComparisonOperator.NotEquals: return an != en;
                    case ComparisonOperator.GreaterThan: return an > en;
                    case ComparisonOperator.GreaterThanOrEqual: return an >= en;
                    case ComparisonOperator.LessThan: return an < en;
                    case ComparisonOperator.LessThanOrEqual: return an <= en;
                }
            }
            if (DateTime.TryParse(actual, CultureInfo.InvariantCulture, DateTimeStyles.None, out var ad) &&
                DateTime.TryParse(expected, CultureInfo.InvariantCulture, DateTimeStyles.None, out var ed))
            {
                switch (op)
                {
                    case ComparisonOperator.Equals: return ad == ed;
                    case ComparisonOperator.NotEquals: return ad != ed;
                    case ComparisonOperator.GreaterThan: return ad > ed;
                    case ComparisonOperator.GreaterThanOrEqual: return ad >= ed;
                    case ComparisonOperator.LessThan: return ad < ed;
                    case ComparisonOperator.LessThanOrEqual: return ad <= ed;
                }
            }
            switch (op)
            {
                case ComparisonOperator.Equals: return string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
                case ComparisonOperator.NotEquals: return !string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
                case ComparisonOperator.Contains: return actual?.IndexOf(expected ?? "", StringComparison.OrdinalIgnoreCase) >= 0;
                case ComparisonOperator.DoesNotContain: return !(actual?.IndexOf(expected ?? "", StringComparison.OrdinalIgnoreCase) >= 0);
                case ComparisonOperator.IsNull: return string.IsNullOrEmpty(actual);
                case ComparisonOperator.IsNotNull: return !string.IsNullOrEmpty(actual);
                default: return false;
            }
        }
    }
}
