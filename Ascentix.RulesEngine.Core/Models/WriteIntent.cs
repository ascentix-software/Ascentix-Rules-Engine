using System;
using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Models
{
    /// <summary>
    /// A fully-resolved record write produced by the engine when a write-action fires. The plugin
    /// sends it through the change set; asx_RunRules only reports it. Resolution is side-effect-free.
    /// </summary>
    public class WriteIntent
    {
        public WriteOperation Operation { get; set; }
        public string TargetTable { get; set; }
        /// <summary>The written row. Create: a new id assigned at resolution.</summary>
        public Guid? TargetId { get; set; }
        public bool RootTargeted { get; set; }              // Update onto the in-flight root record
        public RuleEvaluationContext Context { get; set; }  // which service the plugin writes under
        public Dictionary<string, object> Values { get; set; } = new Dictionary<string, object>();

        /// <summary>Set Update/Deactivate: the target row's value of each written column when it was
        /// read. A missing key, or a null dictionary, means unknown: the column counts as changed.</summary>
        public Dictionary<string, object> LoadedValues { get; set; }

        /// <summary>Single-record Update/Deactivate: sent even when nothing changed (the pre-set behavior).</summary>
        public bool AlwaysWrite { get; set; }

        /// <summary>The action that produced the intent: merge order and error messages.</summary>
        public Guid SourceActionId { get; set; }
        public string SourceActionName { get; set; }
        public int SourceActionOrder { get; set; }
    }
}
