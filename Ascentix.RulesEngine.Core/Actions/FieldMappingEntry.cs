using System;
using System.Collections.Generic;
using Ascentix.RulesEngine.Core.Models;

namespace Ascentix.RulesEngine.Core.Actions
{
    /// <summary>One entry in an asx_fieldmapping array: set <see cref="Target"/> from a
    /// literal, a root-record column, a related-node column, a record reference, a string template, a math expression, or a date expression.</summary>
    public class FieldMappingEntry
    {
        public string Target { get; set; }
        public string Source { get; set; }   // "literal" | "root" | "node" | "ref" | "template" | "mathexpr" | "dateexpr"
        public object Value { get; set; }     // decoded literal primitive (Source == "literal")
        public string Column { get; set; }    // source column (Source == "root" | "node")
        public Guid? Node { get; set; }       // tableconfig node id (Source == "node" | "ref")

        public string Template { get; set; }     // token text (Source == "template")
        public string Expression { get; set; }   // arithmetic expression (Source == "mathexpr")

        /// <summary>Per-aggregate filter map keyed by the `filter:&lt;key&gt;` tokens referenced
        /// in <see cref="Expression"/> (Source == "mathexpr" only). Null/empty when the expression
        /// has no filtered aggregates.</summary>
        public Dictionary<string, NodeFilterGroup> Filters { get; set; }

        public string AnchorKind { get; set; }   // "now" | "field" (Source == "dateexpr")
        public Guid? AnchorNode { get; set; }    // field anchor node; null => root record
        public string AnchorColumn { get; set; } // field anchor column
        public string Op { get; set; }           // "add" | "subtract"
        public int Amount { get; set; }          // positive interval size
        public string Unit { get; set; }         // minutes|hours|days|weeks|months|years
    }
}
