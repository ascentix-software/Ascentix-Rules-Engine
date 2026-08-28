"""Live profiling driver: samples perf_root records, calls asx_RunRules with diagnostics,
aggregates results, and writes a timestamped report to docs/perf/reports/ (not committed).

Usage:
    python scripts/perf/run-profile.py [--sample N] [--reps R] [--label LABEL]
"""
import argparse
import csv
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import _dv
from _dv import get, post
from aggregate import aggregate, render_markdown

REPORTS_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "docs", "perf", "reports"
)


def count_table(entity_set):
    """Return the record count for an OData entity set as a string.
    NOTE: Dataverse caps the inline $count at 5000; tables at/over that report
    '5000+ (capped)' rather than the true row count."""
    resp = get(entity_set + "?$count=true&$top=1")
    if resp is None:
        return "0"
    n = resp.get("@odata.count", len(resp.get("value", [])))
    return "5000+ (capped)" if n == 5000 else str(n)


def main():
    parser = argparse.ArgumentParser(description="Run asx_RunRules profiling harness")
    parser.add_argument("--sample", type=int, default=25,
                        help="Number of perf_root records to sample (default: 25)")
    parser.add_argument("--reps", type=int, default=1,
                        help="Number of calls per record (default: 1)")
    parser.add_argument("--label", default="baseline",
                        help="Report label string (default: baseline)")
    args = parser.parse_args()

    # --- Sample perf_root IDs ---
    print("Querying " + str(args.sample) + " PERF root records...")
    resp = get("perf_roots?$select=perf_rootid&$top=" + str(args.sample))
    root_ids = [r["perf_rootid"] for r in resp["value"]]
    if not root_ids:
        print("ERROR: no perf_root records found. Run generate.py first.")
        sys.exit(1)
    print("  Sampled " + str(len(root_ids)) + " root records.")

    # --- Collect diagnostics samples ---
    samples = []
    total_calls = len(root_ids) * args.reps
    done = 0
    for rid in root_ids:
        for _ in range(args.reps):
            resp = post("asx_RunRules", {
                "TableName": "perf_root",
                "RecordId": rid,
                "Triggers": "OnUpdate",
                "IncludeDiagnostics": True,
            }, solution=False)
            diag = json.loads(resp["Diagnostics"])
            samples.append(diag)
            done += 1
            if done % 5 == 0 or done == total_calls:
                print("  " + str(done) + "/" + str(total_calls) + " calls complete")

    print("Collected " + str(len(samples)) + " samples.")

    # --- Query data totals for meta ---
    print("Querying table counts for report meta...")
    perf_tables = [
        ("perf_roots",    "perf_root"),
        ("perf_lookup1s", "perf_lookup1"),
        ("perf_lookup2s", "perf_lookup2"),
        ("perf_lookup3s", "perf_lookup3"),
        ("perf_child1s",  "perf_child1"),
        ("perf_child2s",  "perf_child2"),
        ("perf_child3s",  "perf_child3"),
    ]
    table_counts = []
    for entity_set, label_name in perf_tables:
        try:
            n = count_table(entity_set)
            table_counts.append(label_name + "=" + str(n))
        except Exception as e:
            table_counts.append(label_name + "=?")

    # Rule count: filter to PERF-RULE-namespaced rules (the ones this fixture generated),
    # so the meta excludes any unrelated rules in the environment.
    try:
        rflt = _dv.urllib.parse.quote("startswith(asx_name,'PERF-RULE')")
        rule_resp = get("asx_rules?$count=true&$top=1&$filter=" + rflt)
        rule_count = rule_resp.get("@odata.count", "?") if rule_resp else "?"
    except Exception:
        rule_count = "?"

    totals_str = ", ".join(table_counts) + ", rules=" + str(rule_count)
    config_str = (
        "sample=" + str(len(root_ids))
        + " reps=" + str(args.reps)
        + " total_calls=" + str(total_calls)
    )

    meta = {
        "label": args.label,
        "config": config_str,
        "totals": totals_str,
    }

    # --- Aggregate and render ---
    agg = aggregate(samples)
    md = render_markdown(agg, meta)

    # --- Write report files ---
    os.makedirs(REPORTS_DIR, exist_ok=True)
    date_str = datetime.date.today().isoformat()
    base_name = date_str + "-" + args.label
    md_path = os.path.join(REPORTS_DIR, base_name + ".md")
    csv_path = os.path.join(REPORTS_DIR, base_name + ".csv")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md + "\n")

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["stage", "median", "p95", "max"])
        writer.writerow(["total",
                          agg["totalMs"]["median"],
                          agg["totalMs"]["p95"],
                          agg["totalMs"]["max"]])
        for name, v in sorted(agg["stages"].items(), key=lambda kv: -kv[1]["median"]):
            writer.writerow([name, v["median"], v["p95"], v["max"]])

    print("")
    print("Report written: " + md_path)
    print("CSV written:    " + csv_path)
    print("")
    print("Summary:")
    print("  Samples:          " + str(agg["sampleCount"]))
    print("  Total ms (median): " + str(agg["totalMs"]["median"]))
    print("  Total ms (p95):   " + str(agg["totalMs"]["p95"]))
    print("  Total ms (max):   " + str(agg["totalMs"]["max"]))
    c = agg["counts"]
    print("  Retrieve avg:     " + str(c["retrieveCount_avg"]))
    print("  RetrieveMultiple: " + str(c["retrieveMultipleCount_avg"]))
    print("  Rows fetched avg: " + str(c["rowsFetched_avg"]))


if __name__ == "__main__":
    main()
