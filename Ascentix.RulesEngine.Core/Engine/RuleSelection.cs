using System;

namespace Ascentix.RulesEngine.Core.Engine
{
    /// <summary>Narrows a run: one rule (<see cref="RuleId"/>) and/or every channel
    /// (<see cref="AnyChannel"/>: on-demand runs have no form or portal origin).
    /// <see cref="DraftRuleId"/> evaluates a draft's authored rows in place of the live revision
    /// it is a draft of (or alongside the published rules, for a rule never published): a
    /// preview of what publishing it would do. Only the report-only asx_RunRules sets it.</summary>
    public sealed class RuleSelection
    {
        public Guid? RuleId { get; set; }
        public bool AnyChannel { get; set; }
        public Guid? DraftRuleId { get; set; }
    }
}
