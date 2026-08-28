using System;
using Microsoft.Xrm.Sdk;
using Ascentix.RulesEngine.Schema;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>
    /// Gates a rule by its effective window (asx_effectivefrom / asx_effectiveto, UTC).
    /// In effect iff (from is null or from &lt;= now) and (to is null or now &lt;= to).
    /// Bounds inclusive. Pure, therefore unit-testable.
    /// </summary>
    public static class RuleScheduleFilter
    {
        private static readonly string FromField = SchemaNames.Qualify(SchemaNames.Rule.EffectiveFrom);
        private static readonly string ToField = SchemaNames.Qualify(SchemaNames.Rule.EffectiveTo);

        public static bool IsInEffect(Entity rule, DateTime nowUtc)
        {
            var from = rule.GetAttributeValue<DateTime?>(FromField);
            var to = rule.GetAttributeValue<DateTime?>(ToField);
            if (from.HasValue && nowUtc < from.Value) return false;
            if (to.HasValue && nowUtc > to.Value) return false;
            return true;
        }
    }
}
