using System;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Execution
{
    /// <summary>Applies a date interval (add/subtract N units) to an anchor DateTime. Weeks are
    /// 7 days; months/years use .NET AddMonths/AddYears semantics (month-end clamping), matching
    /// classic workflows. Unknown op/unit is an author configuration error.</summary>
    public static class DateMath
    {
        public static DateTime Apply(DateTime anchor, string op, int amount, string unit)
        {
            int signed;
            switch (op)
            {
                case "add": signed = amount; break;
                case "subtract": signed = -amount; break;
                default:
                    throw new InvalidPluginExecutionException(
                        $"Date expression has unknown op '{op}'. Expected 'add' or 'subtract'.");
            }

            switch (unit)
            {
                case "minutes": return anchor.AddMinutes(signed);
                case "hours": return anchor.AddHours(signed);
                case "days": return anchor.AddDays(signed);
                case "weeks": return anchor.AddDays(signed * 7);
                case "months": return anchor.AddMonths(signed);
                case "years": return anchor.AddYears(signed);
                default:
                    throw new InvalidPluginExecutionException(
                        $"Date expression has unknown unit '{unit}'. Expected minutes, hours, days, weeks, months, or years.");
            }
        }
    }
}
