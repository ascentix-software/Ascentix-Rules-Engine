using System;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Plugin
{
    /// <summary>
    /// Detects whether the current plugin execution was initiated by the engine's own
    /// write actions (a self-cascade to suppress) versus a legitimate external trigger.
    /// </summary>
    public static class PluginReentry
    {
        public const string EngineWriteTag = "asx:rulesengine-write";

        public static bool IsEngineInitiated(IPluginExecutionContext context)
        {
            // The 'tag' shared variable set on the engine's own writes surfaces on the
            // triggered pipeline's context; deeper nesting/stage differences place it on
            // an ancestor, so walk the ParentContext chain.
            for (var ctx = context; ctx != null; ctx = ctx.ParentContext)
            {
                if (ctx.SharedVariables != null
                    && ctx.SharedVariables.TryGetValue("tag", out var tag)
                    && (tag as string) == EngineWriteTag)
                    return true;
            }
            return false;
        }

        /// <summary>Whether this execution is nested inside a call to the given custom API
        /// (qualified message name, e.g. "asx_ProcessRunPage"): an ancestor's MessageName matches,
        /// case-insensitively. A parent context can't be supplied by a Web API caller, so this
        /// can't be spoofed from outside.</summary>
        public static bool IsInsideMessage(IPluginExecutionContext context, string qualifiedMessageName)
        {
            for (var ctx = context?.ParentContext; ctx != null; ctx = ctx.ParentContext)
                if (string.Equals(ctx.MessageName, qualifiedMessageName, StringComparison.OrdinalIgnoreCase))
                    return true;
            return false;
        }
    }
}
