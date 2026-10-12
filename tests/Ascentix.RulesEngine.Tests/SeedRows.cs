using System.Collections.Generic;
using Microsoft.Xrm.Sdk;

namespace Ascentix.RulesEngine.Tests
{
    /// <summary>Lets a seed's collection initializer take several rows at once, such as an action
    /// together with its "Fires when" tree rows.</summary>
    internal static class SeedRows
    {
        public static void Add(this List<Entity> rows, IEnumerable<Entity> more) => rows.AddRange(more);
    }
}
