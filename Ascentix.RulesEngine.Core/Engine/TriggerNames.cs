using System;
using Ascentix.RulesEngine.Core.Models;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>Parses the Triggers string the Custom APIs accept. "Manual" is the old name of
    /// On demand (value 3) and stays accepted.</summary>
    public static class TriggerNames
    {
        public static RuleTrigger Parse(string raw, string apiName, RuleTrigger fallback)
        {
            if (string.IsNullOrWhiteSpace(raw)) return fallback;
            var name = raw.Trim();
            if (string.Equals(name, "Manual", StringComparison.OrdinalIgnoreCase)) return RuleTrigger.OnDemand;
            if (Enum.TryParse<RuleTrigger>(name, ignoreCase: true, out var trigger) && Enum.IsDefined(typeof(RuleTrigger), trigger))
                return trigger;
            throw new InvalidPluginExecutionException(
                $"{apiName}: unknown Triggers value '{raw}'. Expected one of OnCreate, OnForm, OnDemand, OnUpdate, OnDelete.");
        }
    }
}
