"""Perf fixture reset: delete generated rules + data rows; keep schema + tableconfig tree.

Run from repo root:
    python scripts/perf/reset-data.py

Deletes (in order):
  1. asx_rule records named PERF-RULE-* (cascade removes groups/conditions/actions)
  2. Data rows from the 7 perf tables (children first, then roots, then lookups)
     where perf_name startswith 'PERF'

Idempotent -- safe to re-run when already clean.
ASCII-only console output.
"""
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "perf"))
import _dv  # noqa: E402
from _dv import get, delete  # noqa: E402


def delete_rules():
    """Delete PERF-RULE- asx_rule records in paged batches (rules first -- see critical note)."""
    flt = _dv.urllib.parse.quote("startswith(asx_name,'PERF-RULE')")
    total = 0
    while True:
        rules = get(f"asx_rules?$select=asx_ruleid&$filter={flt}&$top=200")["value"]
        if not rules:
            break
        for r in rules:
            delete(f"asx_rules({r['asx_ruleid']})")
        total += len(rules)
    print(f"[delete] asx_rules (PERF-RULE-*): {total} record(s)")


BATCH = 100  # $batch parts per request (Dataverse cap is 1000; 100 keeps each call short)


def _batch_delete(entityset, ids, attempts=4):
    """One $batch request carrying a DELETE per id. Retries transient socket/5xx failures with
    backoff -- 27k single DELETEs tripped WinError 10060 timeouts on 2026-08-22; batching cuts the
    call count ~100x. Individual part failures surface as a non-2xx part status in the body."""
    boundary = f"batch_{uuid.uuid4().hex}"
    lines = []
    for i, rid in enumerate(ids):
        lines += [f"--{boundary}", "Content-Type: application/http", "Content-Transfer-Encoding: binary",
                  f"Content-ID: {i + 1}", "", f"DELETE {_dv.BASE}/{entityset}({rid}) HTTP/1.1",
                  "OData-MaxVersion: 4.0", "OData-Version: 4.0", ""]
    lines.append(f"--{boundary}--")
    body = ("\r\n".join(lines) + "\r\n").encode("utf-8")
    headers = {"Authorization": f"Bearer {_dv._token}", "Content-Type": f"multipart/mixed; boundary={boundary}",
               "Accept": "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0"}
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(f"{_dv.BASE}/$batch", data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                raw = r.read().decode("utf-8")
            failed = [ln for ln in raw.splitlines() if ln.startswith("HTTP/1.1") and not ln.startswith("HTTP/1.1 2")]
            if failed:
                raise SystemExit(f"ERROR $batch DELETE {entityset}: {len(failed)} part(s) failed, e.g. {failed[0]}")
            return
        except urllib.error.HTTPError as e:
            detail = e.read().decode()
            if e.code in (429, 500, 502, 503, 504) and attempt < attempts:
                time.sleep(5 * attempt); continue
            raise SystemExit(f"ERROR $batch DELETE {entityset}: {e.code}\n{detail}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if attempt < attempts:
                print(f"  ... transient error ({e}); retry {attempt}/{attempts - 1} in {10 * attempt}s", flush=True)
                time.sleep(10 * attempt); continue
            raise


def delete_data_table(entityset, idfield, namefield="perf_name"):
    """Page through rows whose name startswith 'PERF' and delete them via $batch."""
    flt = _dv.urllib.parse.quote(f"startswith({namefield},'PERF')")
    total = 0
    while True:
        rows = get(f"{entityset}?$select={idfield}&$filter={flt}&$top=1000")["value"]
        if not rows:
            break
        ids = [r[idfield] for r in rows]
        for i in range(0, len(ids), BATCH):
            _batch_delete(entityset, ids[i:i + BATCH])
        total += len(rows)
        print(f"  {entityset}: {total} deleted so far", flush=True)
    print(f"[delete] {entityset}: {total} record(s)")


def main():
    print("=== Perf fixture reset (rules + data; schema + tableconfig kept) ===")

    # Step 1: RULES FIRST -- Block rules veto perf_root deletes once published.
    # Must remove enforcement before touching any data rows.
    print("\n[1/2] Deleting generated rules...")
    delete_rules()

    # Step 2: Data rows -- children before parents to satisfy FK constraints.
    # Order: child3 -> child2 -> child1 -> roots -> lookup1 -> lookup2 -> lookup3
    print("\n[2/2] Deleting generated data rows (children first)...")
    delete_data_table("perf_child3s",  "perf_child3id")
    delete_data_table("perf_child2s",  "perf_child2id")
    delete_data_table("perf_child1s",  "perf_child1id")
    delete_data_table("perf_roots",    "perf_rootid")
    delete_data_table("perf_lookup1s", "perf_lookup1id")
    delete_data_table("perf_lookup2s", "perf_lookup2id")
    delete_data_table("perf_lookup3s", "perf_lookup3id")

    print("\nDONE. Fixture is clean -- schema and tableconfig tree intact.")


if __name__ == "__main__":
    main()
