import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aggregate import (aggregate, capacity_summary, dominant_stage, empty_summary, render_capacity_markdown,  # noqa: E402
                       render_scenario_markdown, step_result, step_rows, summarize_pages, summarize_saves)


def test_aggregate_computes_median_p95_and_count_averages():
    samples = [
        {"totalMs": 10, "retrieveCount": 4, "retrieveMultipleCount": 2, "rowsFetched": 100,
         "stages": [{"name": "queryExecute", "ms": 6}, {"name": "evaluate", "ms": 4}]},
        {"totalMs": 20, "retrieveCount": 6, "retrieveMultipleCount": 2, "rowsFetched": 200,
         "stages": [{"name": "queryExecute", "ms": 14}, {"name": "evaluate", "ms": 6}]},
    ]
    agg = aggregate(samples)
    assert agg["stages"]["queryExecute"]["median"] == 10   # median of 6,14
    assert agg["stages"]["queryExecute"]["max"] == 14
    assert agg["counts"]["retrieveCount_avg"] == 5         # (4+6)/2
    assert agg["totalMs"]["median"] == 15


def _summary(**kw):
    s = empty_summary()
    counters = kw.pop("counters", {})
    s.update(kw)
    s["counters"] = {**s["counters"], **counters}
    return s


def test_summarize_saves_takes_medians_and_the_slowest_total():
    samples = [
        {"totalMs": 100, "writesSent": 2, "stages": [{"name": "queryExecute", "ms": 60}]},
        {"totalMs": 300, "writesSent": 4, "stages": [{"name": "queryExecute", "ms": 200}, {"name": "evaluate", "ms": 50}]},
        {"totalMs": 200, "writesSent": 3, "stages": [{"name": "queryExecute", "ms": 120}]},
    ]
    s = summarize_saves(samples)
    assert (s["samples"], s["totalMs"], s["maxMs"]) == (3, 200, 300)
    assert s["stages"] == {"queryExecute": 120, "evaluate": 0}
    assert s["counters"]["writesSent"] == 3 and s["counters"]["pageRecords"] == 0


def test_summarize_pages_sums_pages_and_derives_records_per_hour():
    pages = [{"totalMs": 1000, "pageRecords": 500, "stages": [{"name": "pageEvaluate", "ms": 800}]},
             {"totalMs": 800, "pageRecords": 300,
              "stages": [{"name": "pageEvaluate", "ms": 600}, {"name": "pageWrite", "ms": 100}]}]
    s = summarize_pages(pages)
    assert (s["samples"], s["totalMs"], s["maxMs"]) == (2, 1800, 1000)
    assert s["counters"]["pageRecords"] == 800
    assert s["stages"] == {"pageEvaluate": 1400, "pageWrite": 100}
    assert s["recordsPerHour"] == 1600000   # 800 * 3,600,000 / 1,800


def test_empty_inputs_summarize_to_zeros():
    assert summarize_saves([]) == empty_summary() == summarize_pages([])


def test_dominant_stage_skips_page_containers_when_finer_stages_exist():
    assert dominant_stage({"totalMs": 1000, "stages": {"pageEvaluate": 900, "queryExecute": 600, "pageSelect": 50}}) \
        == ("queryExecute", 0.6)
    assert dominant_stage({"totalMs": 100, "stages": {"pageEvaluate": 90}}) == ("pageEvaluate", 0.9)
    assert dominant_stage(empty_summary()) == (None, 0.0)


def test_step_rows_have_one_row_per_step_with_counters_then_stages():
    results = [step_result("S3", 100, _summary(samples=5, totalMs=900, maxMs=1000,
                                               stages={"dispatch:Update:perf_child1": 300}, counters={"writesSent": 133}), None),
               step_result("S3", 500, None, "save 2: 500 timeout")]
    header, rows = step_rows(results)
    assert header[:8] == ["scenario", "step", "result", "error", "samples", "totalMs", "maxMs", "recordsPerHour"]
    assert header[-1] == "stage:dispatch:Update:perf_child1"
    assert rows[0][:8] == ["S3", "100", "pass", "", 5, 900, 1000, 0]
    assert rows[0][header.index("writesSent")] == 133 and rows[0][-1] == 300
    assert rows[1][2:4] == ["fail", "save 2: 500 timeout"] and rows[1][-1] == 0


def test_scenario_markdown_lists_each_step_and_its_stages():
    results = [step_result("S1", 100, _summary(samples=5, totalMs=400, maxMs=450, stages={"queryExecute": 300}), None),
               step_result("S1", 500, _summary(samples=5, totalMs=2600, maxMs=2900, stages={"queryExecute": 2100}),
                           "median totalMs 2600 > 2000")]
    md = render_scenario_markdown("S1", "baseline", "2026-09-30", results)
    assert md.startswith("# S1 -- baseline (2026-09-30)")
    assert "| 100 | pass | 5 | 400 | 450 | queryExecute (75%) |  |" in md
    assert "| 500 | fail | 5 | 2600 | 2900 | queryExecute (81%) | median totalMs 2600 > 2000 |" in md
    assert "| queryExecute | 300 | 2100 |" in md


def test_capacity_summary_names_the_last_pass_the_first_fail_and_its_error():
    s1 = [step_result("S1", "100", _summary(totalMs=400, stages={"queryExecute": 300, "evaluate": 50}), None),
          step_result("S1", "500", _summary(totalMs=1500, stages={"queryExecute": 1200}), None),
          step_result("S1", "2000", _summary(totalMs=2600), "median totalMs 2600 > 2000")]
    s5 = [step_result("S5", "1", _summary(totalMs=900, stages={"scheduleStart": 700}), None)]
    rows = capacity_summary({"S5": s5, "S1": s1})
    assert [r["scenario"] for r in rows] == ["S1", "S5"]
    assert (rows[0]["lastPass"], rows[0]["firstFail"], rows[0]["error"]) == ("500", "2000", "median totalMs 2600 > 2000")
    assert (rows[0]["dominantStage"], rows[0]["dominantShare"]) == ("queryExecute", 0.8)
    assert rows[1]["firstFail"] is None
    md = render_capacity_markdown("baseline", "2026-09-30", rows)
    assert "| S1 | 500 | 2000 | median totalMs 2600 > 2000 | queryExecute (80%) |" in md
    assert "| S5 | 1 | none (every step passed) |  | scheduleStart (78%) |" in md


def test_captured_diagnostics_rows_show_in_the_rows_the_markdown_and_the_capacity_summary():
    # S2/S3 figures come from the saves' asx_rulediagnostic rows; the reports say how many were found.
    s2 = [step_result("S2", "100", _summary(samples=3, totalMs=700, maxMs=700, stages={"queryExecute": 350}), None),
          step_result("S2", "500", _summary(samples=2, totalMs=900), "found 2 of 5 diagnostics rows")]
    s2[0]["diagCaptured"], s2[1]["diagCaptured"] = "3/5", "2/5"
    header, rows = step_rows(s2)
    assert header[4] == "diagCaptured" and [r[4] for r in rows] == ["3/5", "2/5"]
    md = render_scenario_markdown("S2", "baseline", "2026-09-30", s2)
    assert "| Step | Result | Samples | total ms | max ms | Dominant stage | Error | Diagnostics rows found |" in md
    assert "| 100 | pass | 3 | 700 | 700 | queryExecute (50%) |  | 3/5 |" in md
    s1 = [step_result("S1", "100", _summary(totalMs=400, stages={"queryExecute": 300}), None)]
    rows = capacity_summary({"S1": s1, "S2": s2})
    assert [r["diagCaptured"] for r in rows] == [None, "3/5"]
    md = render_capacity_markdown("baseline", "2026-09-30", rows)
    assert "| Dominant stage at the top passing step | Diagnostics rows found there |" in md
    assert "| S1 | 100 | none (every step passed) |  | queryExecute (75%) |  |" in md
    assert "| S2 | 100 | 500 | found 2 of 5 diagnostics rows | queryExecute (50%) | 3/5 |" in md
    assert step_rows(s1)[0][4] == "samples"                      # no column when no step read diagnostics rows


def test_the_background_rule_count_shows_in_the_rows_the_markdown_and_the_capacity_summary():
    # I-3: runs with different --rules must be told apart; a merged report can mix counts across steps.
    s1 = [step_result("S1", "100", _summary(samples=5, totalMs=400, stages={"queryExecute": 300}), None),
          step_result("S1", "500", _summary(samples=5, totalMs=900, stages={"queryExecute": 800}), None),
          step_result("S1", "2000", _summary(samples=5, totalMs=2600), "median totalMs 2600 > 2000")]
    s1[0]["backgroundRules"], s1[1]["backgroundRules"], s1[2]["backgroundRules"] = 0, 0, 100
    header, rows = step_rows(s1)
    assert header[4] == "backgroundRules" and [r[4] for r in rows] == [0, 0, 100]
    md = render_scenario_markdown("S1", "baseline", "2026-09-30", s1)
    assert "Background rules: 0 (steps 100, 500), 100 (step 2000)" in md
    uniform = render_scenario_markdown("S1", "baseline", "2026-09-30", s1[:2])
    assert "Background rules: 0\n" in uniform
    s5 = [step_result("S5", "1", _summary(totalMs=900), None)]
    md = render_capacity_markdown("baseline", "2026-09-30", capacity_summary({"S1": s1, "S5": s5}))
    assert "| Scenario | Background rules | Last passing step |" in md
    assert "| S1 | 0 | 500 | 2000 |" in md and "| S5 |  | 1 | none (every step passed) |" in md
    # No column, and no header line, when no step records a count (reports written before --rules).
    assert "Background rules" not in render_scenario_markdown("S5", "baseline", "2026-09-30", s5)
    assert step_rows(s5)[0][4] == "samples"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("OK")
