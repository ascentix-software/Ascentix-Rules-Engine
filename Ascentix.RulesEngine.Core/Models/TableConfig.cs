using System;

namespace Ascentix.RulesEngine.Core.Models
{
    // ─── Table Config ─────────────────────────────────────────────────────────

    public class TableConfig
    {
        public Guid Id { get; set; }
        public string TableLogicalName { get; set; }
        public TableConfigType ConfigType { get; set; }
        public Guid? ParentTableId { get; set; }

        /// <summary>
        /// LookupTable nodes only.
        /// The field on the PARENT record that holds the reference to this table.
        /// </summary>
        public string LookupColumnLogicalName { get; set; }

        /// <summary>
        /// ChildTable nodes only.
        /// The field on THIS table that holds the foreign key back to the parent.
        /// </summary>
        public string ChildLinkField { get; set; }

        /// <summary>
        /// LookupTable nodes only.
        /// The primary-id attribute of the lookup TARGET table (this node's TableLogicalName),
        /// used to batch-fetch targets via an IN-query. Config-stored and enforced (no fallback).
        /// </summary>
        public string LookupTargetIdAttribute { get; set; }

        /// <summary>
        /// 0 = root, 1 = direct child of root, etc. Owned by <see cref="TableConfigTree"/>:
        /// written only by tree construction (correct by construction: a hand-set depth is not
        /// possible outside this assembly), read by anything that still holds the node.
        /// </summary>
        public int Depth { get; internal set; }
    }
}
