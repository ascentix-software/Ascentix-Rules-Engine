using System;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>Narrows a run: one rule (<see cref="RuleId"/>) and/or every channel
    /// (<see cref="AnyChannel"/>: on-demand runs have no form or portal origin).</summary>
    public sealed class RuleSelection
    {
        public Guid? RuleId { get; set; }
        public bool AnyChannel { get; set; }
    }
}
