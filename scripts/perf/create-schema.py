"""Create the perf-harness publisher, solution, tables, columns, and relationships.
Idempotent: checks for each component before creating. Run from repo root:
    python scripts/perf/create-schema.py
"""
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "perf"))
import _dv  # noqa: E402
from _dv import get as _get, post, patch, label, publish_all  # noqa: E402


def get(path):
    """Wrap _dv.get to percent-encode spaces in query strings (Python 3.13 urlopen is strict)."""
    if "?" in path:
        base_path, qs = path.split("?", 1)
        path = base_path + "?" + qs.replace(" ", "%20").replace("'", "%27")
    return _get(path)


PFX = "perf"

# ---------------------------------------------------------------------------
# Data tables driving creation
# ---------------------------------------------------------------------------

TABLES = [
    ("perf_Root",    "Perf Root",    "Perf Roots"),
    ("perf_Lookup1", "Perf Lookup1", "Perf Lookup1s"),
    ("perf_Lookup2", "Perf Lookup2", "Perf Lookup2s"),
    ("perf_Lookup3", "Perf Lookup3", "Perf Lookup3s"),
    ("perf_Child1",  "Perf Child1",  "Perf Child1s"),
    ("perf_Child2",  "Perf Child2",  "Perf Child2s"),
    ("perf_Child3",  "Perf Child3",  "Perf Child3s"),
]

# Typed column logical names added to every table (after table creation)
TYPED_COLUMNS = ["perf_text", "perf_number", "perf_amount", "perf_flag", "perf_category", "perf_date"]

# (referencing_table, lookup_schema_name, referenced_table)
RELATIONSHIPS = [
    ("perf_root",    "perf_Lookup1Id",      "perf_lookup1"),
    ("perf_root",    "perf_ParentRootId",   "perf_root"),      # self-ref
    ("perf_root",    "perf_SibLookup1",     "perf_lookup1"),
    ("perf_root",    "perf_SibLookup2",     "perf_lookup1"),
    ("perf_root",    "perf_SibLookup3",     "perf_lookup1"),
    ("perf_root",    "perf_SibLookup4",     "perf_lookup1"),
    ("perf_root",    "perf_SibLookup5",     "perf_lookup1"),
    ("perf_root",    "perf_SibLookup6",     "perf_lookup1"),
    ("perf_lookup1", "perf_Lookup2Id",      "perf_lookup2"),
    ("perf_lookup2", "perf_Lookup3Id",      "perf_lookup3"),
    ("perf_child1",  "perf_RootId",         "perf_root"),
    ("perf_child1",  "perf_Child1LookupId", "perf_lookup1"),   # child-level lookup (N+1)
    ("perf_child2",  "perf_Child1Id",       "perf_child1"),
    ("perf_child3",  "perf_Child2Id",       "perf_child2"),
]


# ---------------------------------------------------------------------------
# Publisher + solution
# ---------------------------------------------------------------------------

def ensure_publisher():
    existing = get("publishers?$select=publisherid,customizationprefix"
                   "&$filter=customizationprefix eq 'perf'")
    if existing["value"]:
        pid = existing["value"][0]["publisherid"]
        print(f"[skip] publisher (prefix perf) {pid}")
        return pid
    pid = post("publishers", {
        "uniquename": "ascentixperf",
        "friendlyname": "Ascentix Perf",
        "customizationprefix": "perf",
        "customizationoptionvalueprefix": 30000,
    }, solution=False)
    print(f"[create] publisher {pid}")
    return pid


def ensure_solution(pid):
    existing = get("solutions?$select=solutionid&$filter=uniquename eq 'PerfHarness'")
    if existing["value"]:
        print("[skip] solution PerfHarness")
        return existing["value"][0]["solutionid"]
    sid = post("solutions", {
        "uniquename": "PerfHarness",
        "friendlyname": "Perf Harness",
        "version": "1.0.0.0",
        "publisherid@odata.bind": f"/publishers({pid})",
    }, solution=False)
    print(f"[create] solution {sid}")
    return sid


# ---------------------------------------------------------------------------
# Table + column helpers
# ---------------------------------------------------------------------------

def table_exists(logical):
    r = get(f"EntityDefinitions?$select=LogicalName&$filter=LogicalName eq '{logical}'")
    return bool(r["value"])


def attr_exists(table_logical, col_logical):
    r = get(f"EntityDefinitions(LogicalName='{table_logical}')/Attributes"
            f"?$select=LogicalName&$filter=LogicalName eq '{col_logical}'")
    return bool(r["value"])


def create_table(schema, display, plural):
    """Create a user-owned table with a string primary name column perf_name."""
    logical = schema.lower()
    if table_exists(logical):
        print(f"[skip] table {logical}")
        return
    entity = {
        "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
        "SchemaName": schema,
        "DisplayName": label(display),
        "DisplayCollectionName": label(plural),
        "OwnershipType": "UserOwned",
        "HasActivities": False, "HasNotes": False, "IsActivity": False,
        "Attributes": [{
            "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
            "SchemaName": f"{PFX}_Name",
            "DisplayName": label("Name"),
            "RequiredLevel": {"Value": "ApplicationRequired"},
            "MaxLength": 200, "IsPrimaryName": True,
        }],
    }
    post("EntityDefinitions", entity)
    print(f"[create] table {logical}")


def _attr_path(table_logical):
    return f"EntityDefinitions(LogicalName='{table_logical}')/Attributes"


def add_string(table, col, disp, maxlen=200, fmt="Text"):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp),
        "RequiredLevel": {"Value": "None"}, "MaxLength": maxlen, "FormatName": {"Value": fmt},
    })
    print(f"[create] {table}.{logical} (string)")


def add_int(table, col, disp):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp),
        "RequiredLevel": {"Value": "None"}, "MinValue": 0, "MaxValue": 1000000,
    })
    print(f"[create] {table}.{logical} (int)")


def add_decimal(table, col, disp):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp),
        "RequiredLevel": {"Value": "None"}, "MinValue": 0.0, "MaxValue": 1000000000.0,
        "Precision": 2,
    })
    print(f"[create] {table}.{logical} (decimal)")


def add_bool(table, col, disp):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp), "RequiredLevel": {"Value": "None"},
        "OptionSet": {
            "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
            "TrueOption": {"Value": 1, "Label": label("Yes")},
            "FalseOption": {"Value": 0, "Label": label("No")},
        },
        "DefaultValue": False,
    })
    print(f"[create] {table}.{logical} (bool)")


def add_choice(table, col, disp, pairs):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    options = [{"Value": v, "Label": label(t)} for v, t in pairs]
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp), "RequiredLevel": {"Value": "None"},
        "OptionSet": {
            "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
            "IsGlobal": False, "OptionSetType": "Picklist",
            "Options": options,
        },
    })
    print(f"[create] {table}.{logical} (choice)")


def add_datetime(table, col, disp):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp), "RequiredLevel": {"Value": "None"},
        "Format": "DateOnly", "DateTimeBehavior": {"Value": "UserLocal"},
    })
    print(f"[create] {table}.{logical} (datetime)")


def add_typed_columns(table_logical):
    """Add the standard typed column spread to a table."""
    add_string(table_logical,   "perf_Text",     "Text",     maxlen=200)
    add_int(table_logical,      "perf_Number",   "Number")
    add_decimal(table_logical,  "perf_Amount",   "Amount")
    add_bool(table_logical,     "perf_Flag",     "Flag")
    add_choice(table_logical,   "perf_Category", "Category",
               [(30001, "Option A"), (30002, "Option B"), (30003, "Option C")])
    add_datetime(table_logical, "perf_Date",     "Date")


# ---------------------------------------------------------------------------
# Relationship helpers
# ---------------------------------------------------------------------------

def relationship_exists(rel_schema):
    r = get(f"RelationshipDefinitions?$select=SchemaName&$filter=SchemaName eq '{rel_schema}'")
    return bool(r["value"])


def create_lookup(referencing, lookup_schema, referenced):
    # Build a globally-unique relationship schema name, strip double-prefix if it appears
    rel_schema = f"perf_{referenced}_{referencing}_{lookup_schema}".replace("perf_perf_", "perf_")
    if relationship_exists(rel_schema):
        print(f"[skip] relationship {rel_schema}")
        return
    body = {
        "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
        "SchemaName": rel_schema,
        "ReferencedEntity": referenced,
        "ReferencingEntity": referencing,
        "Lookup": {
            "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
            "SchemaName": lookup_schema,
            "DisplayName": label(lookup_schema),
            "RequiredLevel": {"Value": "None"},
        },
    }
    post("RelationshipDefinitions", body, solution=True)
    print(f"[create] relationship {rel_schema} ({referencing}.{lookup_schema.lower()} -> {referenced})")


def wait(label_text, secs=20):
    print(f"... waiting {secs}s for {label_text} to propagate")
    time.sleep(secs)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    pid = ensure_publisher()
    ensure_solution(pid)

    # Phase 1 — tables (each gets perf_name primary column)
    for schema, display, plural in TABLES:
        create_table(schema, display, plural)
    wait("tables")

    # Phase 2 — typed columns on every table
    for schema, _, _ in TABLES:
        add_typed_columns(schema.lower())
    wait("columns")

    # Phase 3 — relationships (referenced tables already created above)
    for referencing, lookup_schema, referenced in RELATIONSHIPS:
        create_lookup(referencing, lookup_schema, referenced)
    wait("relationships")

    publish_all()
    print("\nDONE. perf schema created + published.")


if __name__ == "__main__":
    main()
