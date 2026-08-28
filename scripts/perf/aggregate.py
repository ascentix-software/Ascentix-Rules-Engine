"""Pure aggregation of asx_RunRules diagnostics samples. No Dataverse dependency."""
import statistics


def _percentile(values, pct):
    if not values:
        return 0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((pct / 100.0) * (len(s) - 1)))))
    return s[k]


def aggregate(samples):
    stage_names = set()
    for s in samples:
        for st in s.get("stages", []):
            stage_names.add(st["name"])

    stages = {}
    for name in stage_names:
        vals = []
        for s in samples:
            ms = next((st["ms"] for st in s.get("stages", []) if st["name"] == name), 0)
            vals.append(ms)
        stages[name] = {
            "median": int(statistics.median(vals)),
            "p95": _percentile(vals, 95),
            "max": max(vals),
        }

    totals = [s.get("totalMs", 0) for s in samples]
    def avg(key):
        xs = [s.get(key, 0) for s in samples]
        return int(round(sum(xs) / len(xs))) if xs else 0

    return {
        "sampleCount": len(samples),
        "totalMs": {"median": int(statistics.median(totals)) if totals else 0,
                     "p95": _percentile(totals, 95), "max": max(totals) if totals else 0},
        "stages": stages,
        "counts": {
            "retrieveCount_avg": avg("retrieveCount"),
            "retrieveMultipleCount_avg": avg("retrieveMultipleCount"),
            "rowsFetched_avg": avg("rowsFetched"),
        },
    }


def render_markdown(agg, meta):
    lines = ["# Perf report -- " + meta.get("label", ""), ""]
    lines.append("- Samples: " + str(agg["sampleCount"]))
    lines.append("- Config: " + meta.get("config", ""))
    lines.append("- Data totals: " + meta.get("totals", ""))
    lines.append("")
    lines.append("| Stage | median ms | p95 ms | max ms |")
    lines.append("|---|---|---|---|")
    lines.append(
        "| **total** | "
        + str(agg["totalMs"]["median"]) + " | "
        + str(agg["totalMs"]["p95"]) + " | "
        + str(agg["totalMs"]["max"]) + " |"
    )
    for name, v in sorted(agg["stages"].items(), key=lambda kv: -kv[1]["median"]):
        lines.append(
            "| " + name + " | "
            + str(v["median"]) + " | "
            + str(v["p95"]) + " | "
            + str(v["max"]) + " |"
        )
    lines.append("")
    c = agg["counts"]
    lines.append(
        "Avg queries: Retrieve=" + str(c["retrieveCount_avg"])
        + ", RetrieveMultiple=" + str(c["retrieveMultipleCount_avg"])
        + ", rows=" + str(c["rowsFetched_avg"])
    )
    return "\n".join(lines)
