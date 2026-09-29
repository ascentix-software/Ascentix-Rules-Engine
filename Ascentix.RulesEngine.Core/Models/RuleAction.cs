using System;
using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Models
{
    // ─── Rule Action ──────────────────────────────────────────────────────────

    /// <summary>
    /// An outcome attached to a rule (asx_ruleaction). Fires per <see cref="FireOn"/>
    /// against the rule's match result.
    /// </summary>
    public class RuleAction
    {
        public Guid Id { get; set; }
        public Guid RuleId { get; set; }
        public ActionType ActionType { get; set; }
        public ActionFireOn FireOn { get; set; }
        public string TargetColumn { get; set; }
        public bool ValueBool { get; set; }
        public bool ApplyInverseWhenNotFired { get; set; }
        public string Message { get; set; }
        public Severity? Severity { get; set; }
        public string TargetTable { get; set; }
        public Guid? TargetNodeId { get; set; }
        public string FieldMapping { get; set; }
        public int Order { get; set; }
        public bool IsActive { get; set; }

        /// <summary>Update Record only: when the save changes the lookup above this action's target,
        /// also apply the action to the lookup's previous record (see PreviousParent).</summary>
        public bool ApplyToPrevious { get; set; }

        /// <summary>Per-language message text (LCID → text). Empty ⇒ use <see cref="Message"/>.</summary>
        public IDictionary<int, string> LocalizedMessages { get; set; } = new Dictionary<int, string>();
    }
}
