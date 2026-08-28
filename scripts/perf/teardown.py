"""Perf fixture full teardown: rules + data + tableconfig tree + tables + solution + publisher.

Run from repo root:
    python scripts/perf/teardown.py           # live -- DESTRUCTIVE
    python scripts/perf/teardown.py --dry-run # print planned deletions only; no writes issued

DESTRUCTIVE -- removes all perf_ schema and PerfHarness solution from the dev env.
Idempotent -- safe to re-run; skips components that are already absent.
ASCII-only console output.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "perf"))
import _dv  # noqa: E402
from _dv import get, delete  # noqa: E402


# ---------------------------------------------------------------------------
# Ordered list of the 15 tableconfig nodes -- leaf-to-root so the self-ref
# restrict-on-delete (asx_parenttable) is not violated.
# ---------------------------------------------------------------------------
TABLECONFIG_NAMES = [
    # Deepest dependents first
    "PERF Child1 Lookup",
    "PERF Child3",
    "PERF Child2",
    "PERF Child1",
    "PERF L3",
    "PERF L2",
    "PERF L1",
    "PERF Sib1",
    "PERF Sib2",
    "PERF Sib3",
    "PERF Sib4",
    "PERF Sib5",
    "PERF Sib6",
    "PERF Self",
    "PERF Root",  # root last
]

# 7 perf tables -- children before parents so FK deletes succeed
PERF_TABLES = [
    "perf_child3",
    "perf_child2",
    "perf_child1",
    "perf_root",
    "perf_lookup1",
    "perf_lookup2",
    "perf_lookup3",
]

SOLUTION_UNIQUE   = "PerfHarness"
# Publisher uniquename is 'ascentixperf' (customizationprefix is 'perf') — see create-schema.py.
PUBLISHER_UNIQUE  = "ascentixperf"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _page_rules():
    """Return list of (id, name) for all PERF-RULE- asx_rule records."""
    flt = _dv.urllib.parse.quote("startswith(asx_name,'PERF-RULE')")
    result = []
    url = f"asx_rules?$select=asx_ruleid,asx_name&$filter={flt}&$top=200"
    while url:
        page = get(url)
        result.extend(page.get("value", []))
        url = page.get("@odata.nextLink")
    return result


def _page_data(entityset, idfield, namefield="perf_name"):
    """Return list of id values for rows whose name startswith 'PERF'."""
    flt = _dv.urllib.parse.quote(f"startswith({namefield},'PERF')")
    result = []
    url = f"{entityset}?$select={idfield}&$filter={flt}&$top=200"
    while url:
        page = get(url)
        result.extend([r[idfield] for r in page.get("value", [])])
        url = page.get("@odata.nextLink")
    return result


def _page_tableconfigs(name):
    """Return list of id values for asx_tableconfig where asx_name eq name."""
    flt = _dv.urllib.parse.quote(f"asx_name eq '{name}'")
    recs = get(f"asx_tableconfigs?$select=asx_tableconfigid&$filter={flt}")
    return [r["asx_tableconfigid"] for r in recs.get("value", [])]


def _get_table_metadata_id(logical_name):
    """Return MetadataId for a table, or None if absent."""
    flt = _dv.urllib.parse.quote(f"LogicalName eq '{logical_name}'")
    r = get(f"EntityDefinitions?$select=MetadataId&$filter={flt}")
    items = r.get("value", [])
    return items[0]["MetadataId"] if items else None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(dry_run=False):
    mode = "DRY-RUN (no writes)" if dry_run else "LIVE (destructive)"
    print(f"=== Perf fixture full teardown [{mode}] ===")

    # ------------------------------------------------------------------
    # Step 1: Rules first -- Block rules veto perf_root deletes once
    # published.  Must remove enforcement before touching any data rows.
    # ------------------------------------------------------------------
    print("\n[1/6] Scanning PERF-RULE- asx_rule records...")
    rules = _page_rules()
    print(f"      Found {len(rules)} rule(s)")
    if not dry_run:
        deleted = 0
        flt = _dv.urllib.parse.quote("startswith(asx_name,'PERF-RULE')")
        while True:
            page = get(f"asx_rules?$select=asx_ruleid&$filter={flt}&$top=200")["value"]
            if not page:
                break
            for r in page:
                delete(f"asx_rules({r['asx_ruleid']})")
            deleted += len(page)
        print(f"      Deleted {deleted} rule(s)")

    # ------------------------------------------------------------------
    # Step 2: Data rows -- children first, then roots, then lookups
    # ------------------------------------------------------------------
    data_tables = [
        ("perf_child3s",  "perf_child3id"),
        ("perf_child2s",  "perf_child2id"),
        ("perf_child1s",  "perf_child1id"),
        ("perf_roots",    "perf_rootid"),
        ("perf_lookup1s", "perf_lookup1id"),
        ("perf_lookup2s", "perf_lookup2id"),
        ("perf_lookup3s", "perf_lookup3id"),
    ]
    print("\n[2/6] Scanning data rows (PERF-namespaced)...")
    for entityset, idfield in data_tables:
        ids = _page_data(entityset, idfield)
        print(f"      {entityset}: {len(ids)} row(s)")
        if not dry_run:
            deleted = 0
            flt = _dv.urllib.parse.quote("startswith(perf_name,'PERF')")
            while True:
                page = get(f"{entityset}?$select={idfield}&$filter={flt}&$top=200")["value"]
                if not page:
                    break
                for r in page:
                    delete(f"{entityset}({r[idfield]})")
                deleted += len(page)
            print(f"        -> deleted {deleted}")

    # ------------------------------------------------------------------
    # Step 3: Tableconfig nodes (leaf-to-root order)
    # ------------------------------------------------------------------
    print("\n[3/6] Scanning asx_tableconfig nodes...")
    tc_plan = []
    for name in TABLECONFIG_NAMES:
        ids = _page_tableconfigs(name)
        tc_plan.append((name, ids))
        print(f"      '{name}': {len(ids)} node(s)")
    if not dry_run:
        for name, ids in tc_plan:
            for guid in ids:
                delete(f"asx_tableconfigs({guid})")
            if ids:
                print(f"      Deleted '{name}'")

    # ------------------------------------------------------------------
    # Step 4: Tables (deleting a table removes its relationships automatically)
    # ------------------------------------------------------------------
    print("\n[4/6] Scanning perf_ tables...")
    table_plan = []
    for logical in PERF_TABLES:
        meta_id = _get_table_metadata_id(logical)
        table_plan.append((logical, meta_id))
        status = "present" if meta_id else "absent"
        print(f"      {logical}: {status}")
    if not dry_run:
        for logical, meta_id in table_plan:
            if meta_id:
                delete(f"EntityDefinitions({meta_id})")
                print(f"      Deleted table {logical}")

    # ------------------------------------------------------------------
    # Step 5: Solution
    # ------------------------------------------------------------------
    print("\n[5/6] Scanning solution...")
    sol_flt = _dv.urllib.parse.quote(f"uniquename eq '{SOLUTION_UNIQUE}'")
    sol = get(f"solutions?$select=solutionid&$filter={sol_flt}")["value"]
    print(f"      Solution '{SOLUTION_UNIQUE}': {'present' if sol else 'absent'}")
    if sol and not dry_run:
        delete(f"solutions({sol[0]['solutionid']})")
        print(f"      Deleted solution '{SOLUTION_UNIQUE}'")

    # ------------------------------------------------------------------
    # Step 6: Publisher
    # ------------------------------------------------------------------
    print("\n[6/6] Scanning publisher...")
    pub_flt = _dv.urllib.parse.quote(f"uniquename eq '{PUBLISHER_UNIQUE}'")
    pub = get(f"publishers?$select=publisherid&$filter={pub_flt}")["value"]
    print(f"      Publisher '{PUBLISHER_UNIQUE}': {'present' if pub else 'absent'}")
    if pub and not dry_run:
        try:
            delete(f"publishers({pub[0]['publisherid']})")
            print(f"      Deleted publisher '{PUBLISHER_UNIQUE}'")
        except SystemExit:
            print(f"      [skip] publisher still referenced -- delete manually if desired")

    if dry_run:
        print("\nDRY-RUN complete. No writes were issued.")
    else:
        print("\nDONE. PerfHarness fully removed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Perf fixture full teardown (rules + data + tableconfig + tables + solution + publisher)."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned deletions without issuing any writes.",
    )
    args = parser.parse_args()
    main(dry_run=args.dry_run)
