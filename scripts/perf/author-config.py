"""Create the asx_tableconfig tree for the perf root (idempotent by asx_name).

Builds one root tree with all traversal shapes needed for performance testing:
  - RootTable, LookupTable (deep chain, self-ref, sibling lookups), ChildTable nodes.

Run from repo root:
    python scripts/perf/author-config.py

asx_tableconfigtype values (docs/Schema.md §2.1 + author-rules.py):
    RootTable = 1, LookupTable = 2, ChildTable = 3
"""
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "perf"))
import _dv  # noqa: E402

# ---------------------------------------------------------------------------
# Resolve nav property for asx_parenttable (self-lookup on asx_tableconfig)
# Mirrors author-rules.py line 21: resolve_nav_property("asx_tableconfig", "asx_tableconfig", "asx_parenttable")
# ---------------------------------------------------------------------------
NAV_TC_PARENT = _dv.resolve_nav_property("asx_tableconfig", "asx_tableconfig", "asx_parenttable")

TYPE_ROOT   = 1  # Root Table   — docs/Schema.md §2.1, confirmed in author-rules.py
TYPE_LOOKUP = 2  # Lookup Table — docs/Schema.md §2.1, confirmed in author-rules.py
TYPE_CHILD  = 3  # Child Table  — docs/Schema.md §2.1, confirmed in author-rules.py

# ---------------------------------------------------------------------------
# Node data: (name, table, type_int, parent_name, lookup_col, child_link)
# ---------------------------------------------------------------------------
NODES = [
    # Root
    ("PERF Root",         "perf_root",    TYPE_ROOT,   None,           None,                  None),
    # Lookup chain
    ("PERF L1",           "perf_lookup1", TYPE_LOOKUP, "PERF Root",   "perf_lookup1id",       None),
    ("PERF L2",           "perf_lookup2", TYPE_LOOKUP, "PERF L1",     "perf_lookup2id",       None),
    ("PERF L3",           "perf_lookup3", TYPE_LOOKUP, "PERF L2",     "perf_lookup3id",       None),
    # Self-reference on perf_root
    ("PERF Self",         "perf_root",    TYPE_LOOKUP, "PERF Root",   "perf_parentrootid",    None),
    # Sibling lookups (all point to perf_lookup1, hang off PERF Root)
    ("PERF Sib1",         "perf_lookup1", TYPE_LOOKUP, "PERF Root",   "perf_siblookup1",      None),
    ("PERF Sib2",         "perf_lookup1", TYPE_LOOKUP, "PERF Root",   "perf_siblookup2",      None),
    ("PERF Sib3",         "perf_lookup1", TYPE_LOOKUP, "PERF Root",   "perf_siblookup3",      None),
    ("PERF Sib4",         "perf_lookup1", TYPE_LOOKUP, "PERF Root",   "perf_siblookup4",      None),
    ("PERF Sib5",         "perf_lookup1", TYPE_LOOKUP, "PERF Root",   "perf_siblookup5",      None),
    ("PERF Sib6",         "perf_lookup1", TYPE_LOOKUP, "PERF Root",   "perf_siblookup6",      None),
    # Child chain
    ("PERF Child1",       "perf_child1",  TYPE_CHILD,  "PERF Root",   None,                   "perf_rootid"),
    ("PERF Child2",       "perf_child2",  TYPE_CHILD,  "PERF Child1", None,                   "perf_child1id"),
    ("PERF Child3",       "perf_child3",  TYPE_CHILD,  "PERF Child2", None,                   "perf_child2id"),
    # Lookup hanging off the child (perf_child1 -> perf_lookup1)
    ("PERF Child1 Lookup","perf_lookup1", TYPE_LOOKUP, "PERF Child1", "perf_child1lookupid",  None),
]


def _encode(s):
    """Percent-encode a string for use in OData filter values."""
    return s.replace("'", "''")


def find_existing(name):
    """Return the GUID of an asx_tableconfig with the given asx_name, or None."""
    flt = urllib.parse.quote(f"asx_name eq '{_encode(name)}'")
    result = _dv.get(f"asx_tableconfigs?$filter={flt}&$select=asx_tableconfigid")
    items = result.get("value", []) if result else []
    if items:
        return items[0]["asx_tableconfigid"]
    return None


def ensure(name, table, type_int, parent_id=None, lookup_col=None, child_link=None):
    """Create asx_tableconfig if it doesn't exist; return its GUID."""
    existing = find_existing(name)
    if existing:
        print(f"[skip]   {name!r}")
        return existing

    payload = {
        "asx_name":            name,
        "asx_tablelogicalname": table,
        "asx_tableconfigtype": type_int,
    }
    if lookup_col:
        payload["asx_lookupcolumnlogicalname"] = lookup_col
    if type_int == 2:
        # LookupTable nodes must name the target's primary-id attribute (batch-loaded via IN-query);
        # required by the engine since the lookup-batching change — see docs/Schema.md.
        payload["asx_lookuptargetidattribute"] = f"{table}id"
    if child_link:
        payload["asx_childlinkfield"] = child_link
    if parent_id:
        # Bind the self-lookup via @odata.bind — mirrors author-rules.py pattern
        payload[f"{NAV_TC_PARENT}@odata.bind"] = f"/asx_tableconfigs({parent_id})"

    guid = _dv.post("asx_tableconfigs", payload)
    print(f"[create] {name!r}  ->  {guid}")
    return guid


def main():
    print("=== author-config.py: creating asx_tableconfig perf tree ===\n")

    name_to_id = {}

    for (name, table, type_int, parent_name, lookup_col, child_link) in NODES:
        parent_id = name_to_id[parent_name] if parent_name else None
        guid = ensure(name, table, type_int,
                      parent_id=parent_id,
                      lookup_col=lookup_col,
                      child_link=child_link)
        name_to_id[name] = guid

    print(f"\nDONE. {len(NODES)} nodes processed.")


if __name__ == "__main__":
    main()
