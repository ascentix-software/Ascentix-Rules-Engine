using System.Collections.Generic;

namespace Ascentix.RulesEngine.Plugin.Registration
{
    /// <summary>Per-rule facts the StepPlanner needs (built by TableRuleAnalyzer).</summary>
    public class RuleAnalysis
    {
        public bool HasServerAction { get; set; }   // >=1 active action of a server ActionType
        public bool OnCreate { get; set; }
        public bool OnUpdate { get; set; }
        public bool OnDelete { get; set; }
        public bool IsRootOnly { get; set; }         // all conditions reference the root node
        public ISet<string> RootColumns { get; set; } = new HashSet<string>();
    }

    /// <summary>The steps a table needs, computed from its rules.</summary>
    public class DesiredSteps
    {
        public bool Create { get; set; }
        public bool Update { get; set; }
        public bool Delete { get; set; }

        /// <summary>
        /// Update-step filtering attributes. null => fire on ALL columns (a traversal
        /// rule is present, or Update is not needed); a set (possibly empty) => filter
        /// to those columns.
        /// </summary>
        public ISet<string> UpdateFilteringAttributes { get; set; }
    }
}
