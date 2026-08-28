using System;
using System.Collections.Generic;

namespace Ascentix.RulesEngine.Core.Models
{
    /// <summary>
    /// A fully-resolved record write produced by the engine when a write-action fires. The plugin
    /// applies it; asx_RunRules only reports it. Resolution is side-effect-free.
    /// </summary>
    public class WriteIntent
    {
        public WriteOperation Operation { get; set; }
        public string TargetTable { get; set; }
        public Guid? TargetId { get; set; }                 // null for Create
        public bool RootTargeted { get; set; }              // Update onto the in-flight root record
        public RuleEvaluationContext Context { get; set; }  // which service the plugin writes under
        public Dictionary<string, object> Values { get; set; } = new Dictionary<string, object>();
    }
}
