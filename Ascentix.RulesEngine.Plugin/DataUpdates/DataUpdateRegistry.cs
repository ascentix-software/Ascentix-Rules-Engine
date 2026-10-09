using System;
using System.Collections.Generic;

namespace Ascentix.RulesEngine.Plugin.DataUpdates
{
    /// <summary>
    /// Every data update this assembly carries, in Number order. A release that needs existing data
    /// converted adds its IDataUpdate here; nothing else in the framework changes.
    /// </summary>
    public static class DataUpdateRegistry
    {
        public static IReadOnlyList<IDataUpdate> All { get; } = new IDataUpdate[] { new OutcomeConversionUpdate() };
    }
}
