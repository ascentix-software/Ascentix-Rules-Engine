"""Pure aggregation of diagnostics samples: the run-profile.py summary, and the run-scenario.py
per-step summaries, reports and capacity summary. No Dataverse dependency."""
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


# ---------------------------------------------------------------------------
# Scenario ladder: per-step summaries, reports and the capacity summary
# ---------------------------------------------------------------------------

COUNTER_KEYS = [
    "rulesLoaded", "rulesEvaluated", "rulesFired", "retrieveCount", "retrieveMultipleCount", "rowsFetched",
    "writesSent", "writesUnchanged", "writesMerged", "bulkRequests", "singleRequests", "inPlaceWrites",
    "pageRecords", "pageChunks", "pageBlocked", "pageFailed",
    "schedulesStarted", "schedulesContinued", "schedulesSkipped",
]

# A run page's engine and write stages nest inside these two (RunDiagnostics.Absorb), so the
# dominant stage is looked for among the finer stages first.
CONTAINER_STAGES = ("pageEvaluate", "pageWrite")


def _stage_ms(sample, name):
    return next((st["ms"] for st in sample.get("stages", []) if st["name"] == name), 0)


def _stage_names(samples):
    names = []
    for s in samples:
        for st in s.get("stages", []):
            if st["name"] not in names:
                names.append(st["name"])
    return names


def empty_summary():
    return {"samples": 0, "totalMs": 0, "maxMs": 0, "recordsPerHour": 0, "stages": {},
            "counters": {k: 0 for k in COUNTER_KEYS}}


def summarize_saves(samples):
    """One step of per-save (or per-call) diagnostics: the median of every figure, and the slowest total.
    The per-stage and total medians reuse aggregate()'s stage-median logic rather than repeating it."""
    if not samples:
        return empty_summary()
    agg = aggregate(samples)
    totals = [s.get("totalMs", 0) for s in samples]
    return {
        "samples": len(samples),
        "totalMs": agg["totalMs"]["median"],
        "maxMs": max(totals),
        "recordsPerHour": 0,
        "stages": {name: v["median"] for name, v in agg["stages"].items()},
        "counters": {k: int(statistics.median([s.get(k, 0) for s in samples])) for k in COUNTER_KEYS},
    }


def summarize_pages(pages):
    """One Rule Run's asx_ProcessRunPage diagnostics: every figure summed over its pages, the
    slowest page, and records per hour of engine time."""
    if not pages:
        return empty_summary()
    totals = [p.get("totalMs", 0) for p in pages]
    total = sum(totals)
    counters = {k: sum(p.get(k, 0) for p in pages) for k in COUNTER_KEYS}
    return {
        "samples": len(pages),
        "totalMs": total,
        "maxMs": max(totals),
        "recordsPerHour": int(round(counters["pageRecords"] * 3600000 / total)) if total else 0,
        "stages": {n: sum(_stage_ms(p, n) for p in pages) for n in _stage_names(pages)},
        "counters": counters,
    }


def step_result(scenario, step, summary, error):
    return {"scenario": scenario, "step": str(step), "passed": error is None, "error": error,
            "summary": summary if summary is not None else empty_summary()}


def dominant_stage(summary):
    """(stage, share of totalMs) of the largest stage; page containers only when nothing finer exists."""
    stages = summary.get("stages") or {}
    pool = {n: ms for n, ms in stages.items() if n not in CONTAINER_STAGES} or stages
    if not pool:
        return None, 0.0
    name, ms = max(pool.items(), key=lambda kv: kv[1])
    total = summary.get("totalMs") or 0
    return name, (ms / total if total else 0.0)


def _cell(text):
    return "" if text is None else str(text).replace("|", "/").replace("\r", " ").replace("\n", " ")


def _share(name, share):
    return f"{name} ({round(share * 100)}%)" if name else ""


def _captures(results):
    """Whether any step carries diagCaptured (S2/S3: the saves whose asx-diag line Dataverse kept)."""
    return any(r.get("diagCaptured") for r in results)


def step_rows(results):
    captured = _captures(results)
    stage_names = []
    for r in results:
        for n in r["summary"]["stages"]:
            if n not in stage_names:
                stage_names.append(n)
    header = (["scenario", "step", "result", "error"] + (["diagCaptured"] if captured else [])
              + ["samples", "totalMs", "maxMs", "recordsPerHour"]
              + COUNTER_KEYS + ["stage:" + n for n in stage_names])
    rows = []
    for r in results:
        s = r["summary"]
        rows.append([r["scenario"], r["step"], "pass" if r["passed"] else "fail", r["error"] or ""]
                    + ([r.get("diagCaptured") or ""] if captured else [])
                    + [s["samples"], s["totalMs"], s["maxMs"], s["recordsPerHour"]]
                    + [s["counters"].get(k, 0) for k in COUNTER_KEYS]
                    + [s["stages"].get(n, 0) for n in stage_names])
    return header, rows


def render_scenario_markdown(scenario, label, date_str, results):
    captured = _captures(results)
    lines = [f"# {scenario} -- {label} ({date_str})", "",
             "| Step | Result | Samples | total ms | max ms | Dominant stage | Error |"
             + (" asx-diag lines captured |" if captured else ""),
             "|---|---|---|---|---|---|---|" + ("---|" if captured else "")]
    for r in results:
        s = r["summary"]
        lines.append(f"| {r['step']} | {'pass' if r['passed'] else 'fail'} | {s['samples']} | {s['totalMs']} | "
                     f"{s['maxMs']} | {_share(*dominant_stage(s))} | {_cell(r['error'])} |"
                     + (f" {_cell(r.get('diagCaptured'))} |" if captured else ""))
    header, rows = step_rows(results)
    steps = [r["step"] for r in results]

    def table(title, keys, label_of):
        if not keys:
            return
        lines.extend(["", f"## {title}", "", f"| {title.split(' ')[0]} | " + " | ".join(steps) + " |",
                      "|---" * (len(steps) + 1) + "|"])
        for key in keys:
            i = header.index(key)
            lines.append(f"| {label_of(key)} | " + " | ".join(str(row[i]) for row in rows) + " |")

    table("Stage (ms)", [h for h in header if h.startswith("stage:")], lambda k: k[len("stage:"):])
    table("Counter values", [k for k in COUNTER_KEYS + ["recordsPerHour"] if any(row[header.index(k)] for row in rows)],
          lambda k: k)
    return "\n".join(lines)


def capacity_summary(results_by_scenario):
    rows = []
    for scenario in sorted(results_by_scenario):
        results = results_by_scenario[scenario]
        passing = [r for r in results if r["passed"]]
        failing = next((r for r in results if not r["passed"]), None)
        top = passing[-1] if passing else None
        name, share = dominant_stage(top["summary"]) if top else (None, 0.0)
        rows.append({"scenario": scenario,
                     "lastPass": top["step"] if top else None,
                     "firstFail": failing["step"] if failing else None,
                     "error": failing["error"] if failing else None,
                     "dominantStage": name, "dominantShare": share,
                     "diagCaptured": top.get("diagCaptured") if top else None})
    return rows


def render_capacity_markdown(label, date_str, rows):
    captured = _captures(rows)
    lines = [f"# Capacity summary -- {label} ({date_str})", "",
             "| Scenario | Last passing step | First failing step | Error | Dominant stage at the top passing step |"
             + (" asx-diag lines captured there |" if captured else ""),
             "|---|---|---|---|---|" + ("---|" if captured else "")]
    for r in rows:
        lines.append(f"| {r['scenario']} | {r['lastPass'] or 'none'} | {r['firstFail'] or 'none (every step passed)'} | "
                     f"{_cell(r['error'])} | {_share(r['dominantStage'], r['dominantShare'])} |"
                     + (f" {_cell(r.get('diagCaptured'))} |" if captured else ""))
    return "\n".join(lines)
