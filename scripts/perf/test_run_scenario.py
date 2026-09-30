"""Unit tests for run-scenario.py's step logic with a fake Dataverse. Run: python scripts/perf/test_run_scenario.py"""
import datetime
import importlib.util
import json
import os
import re
import sys
import tempfile
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_spec = importlib.util.spec_from_file_location("run_scenario", os.path.join(HERE, "run-scenario.py"))
rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rs)
aggregate = rs.aggregate
profiles = rs.profiles


class FakeOps:
    """Records every call; drive() passes (100 ms) unless told to fail, raise or be interrupted."""

    def __init__(self, fail_at=None, raise_at=None, interrupt_at=None, setup_fails_at=None, trace=1,
                 reset_fails_on=(), clock=None):
        self.calls = []
        self.fail_at, self.raise_at, self.interrupt_at, self.setup_fails_at = fail_at, raise_at, interrupt_at, setup_fails_at
        self.trace = trace
        self.reset_fails_on = reset_fails_on      # which reset calls (1-based) fail, the final reset included
        self.clock = clock                        # when given, every drive takes a minute

    def reset(self):
        self.calls.append(("reset",))
        if sum(1 for c in self.calls if c == ("reset",)) in self.reset_fails_on:
            raise RuntimeError("reset-data.py failed: ERROR DELETE perf_roots(x): 500")

    def prepare(self, scenario, step, sample):
        self.calls.append(("prepare", step))
        if step == self.setup_fails_at:
            raise RuntimeError("generate.py failed: This rule can't be published")

    def drive(self, scenario, step, sample):
        self.calls.append(("drive", step))
        if self.clock:
            self.clock.sleep(60)
        if step == self.interrupt_at:
            raise KeyboardInterrupt()
        if step == self.raise_at:
            raise RuntimeError("PATCH perf_roots(x): 500: plug-in timed out")
        summary = {**aggregate.empty_summary(), "samples": 1, "stages": {"queryExecute": 50},
                   "totalMs": 3000 if step == self.fail_at else 100}
        return [aggregate.step_result(scenario, step, summary, rs.bound_error(scenario, summary))]

    def get_trace_setting(self):
        self.calls.append(("get_trace",))
        return self.trace

    def set_trace_setting(self, value):
        self.calls.append(("set_trace", value))


def test_stops_at_the_first_failing_step_and_resets_between_and_after():
    ops = FakeOps(fail_at=500)
    results = rs.run(ops, "S1", [100, 500, 2000], 5, log=lambda *_: None)
    assert [(r["step"], r["passed"]) for r in results] == [("100", True), ("500", False)]
    assert results[1]["error"] == "median totalMs 3000 > 2000"
    assert ("prepare", 2000) not in ops.calls
    assert [c for c in ops.calls if c[0] == "reset"] == [("reset",)] * 3
    assert ops.calls[0] == ("reset",) and ops.calls[-1] == ("reset",)
    assert not any(c[0].endswith("_trace") for c in ops.calls)   # S1 leaves tracing alone


def test_save_scenarios_switch_tracing_to_all_and_restore_it():
    ops = FakeOps(trace=0)
    rs.run(ops, "S3", [100], 5, log=lambda *_: None)
    assert ops.calls[:2] == [("get_trace",), ("set_trace", 2)]
    assert ops.calls[-2:] == [("reset",), ("set_trace", 0)]


def test_save_scenarios_restore_the_trace_setting_even_when_interrupted():
    ops = FakeOps(interrupt_at=500, trace=1)
    try:
        rs.run(ops, "S2", [100, 500, 2000], 5, log=lambda *_: None)
        assert False, "expected KeyboardInterrupt"
    except KeyboardInterrupt:
        pass
    assert ("set_trace", 2) in ops.calls
    assert ops.calls[-2:] == [("reset",), ("set_trace", 1)]


def test_a_drive_error_is_a_failed_step():
    results = rs.run(FakeOps(raise_at=500), "S3", [100, 500, 2000], 5, log=lambda *_: None)
    assert [r["passed"] for r in results] == [True, False]
    assert results[1]["error"] == "PATCH perf_roots(x): 500: plug-in timed out"


def test_a_setup_error_is_a_failed_step_and_stops_the_ladder():
    ops = FakeOps(setup_fails_at=500)
    results = rs.run(ops, "S1", [100, 500, 2000], 5, log=lambda *_: None)
    assert results[-1]["step"] == "500" and results[-1]["error"].startswith("setup: generate.py failed")
    assert ("drive", 500) not in ops.calls and ("prepare", 2000) not in ops.calls


def test_bounds():
    s = aggregate.empty_summary()
    assert rs.bound_error("S1", {**s, "totalMs": 2000}) is None
    assert rs.bound_error("S6", {**s, "totalMs": 2001}) == "median totalMs 2001 > 2000"
    assert rs.bound_error("S3", {**s, "totalMs": 99999}) is None
    done = {**s, "totalMs": 5000, "counters": {**s["counters"], "schedulesStarted": 6, "schedulesContinued": 4}}
    assert rs.bound_error("S5", done, expected=10) is None
    assert rs.bound_error("S5", done, expected=12) == "10 of 12 due schedules started or continued"
    assert rs.bound_error("S5", {**done, "totalMs": 60001}, expected=10) == "totalMs 60001 > 60000"


def test_parse_diag_lines_reads_every_asx_diag_line_of_a_messageblock():
    block = "\n".join(["[+3ms] - Render language: 1033.",
                       '[+120ms] - asx-diag {"totalMs":120,"writesSent":3,"stages":[]}',
                       "[+1ms] - Exiting RulesEnginePlugin.Execute()"])
    assert rs.parse_diag_lines(block) == [{"totalMs": 120, "writesSent": 3, "stages": []}]
    assert rs.parse_diag_lines(None) == []


def test_parse_diag_lines_skips_a_line_that_does_not_parse():
    # P10: a cut-off or garbled line is skipped (counted as missing), never a crash.
    block = "\n".join(['asx-diag {"totalMs":120,"stages":[{"name":"queryEx',
                       "asx-diag [1, 2]",
                       'asx-diag {"totalMs":80}'])
    assert rs.parse_diag_lines(block) == [{"totalMs": 80}]


def test_diag_lines_per_save_keeps_one_line_per_save_the_slowest():
    # P14: two engine executions of one save (same correlation id) count once, keeping the larger totalMs.
    rows = [{"plugintracelogid": "t1", "correlationid": "c1", "messageblock": 'asx-diag {"totalMs":100}'},
            {"plugintracelogid": "t2", "correlationid": "c1", "messageblock": 'asx-diag {"totalMs":250}'},
            {"plugintracelogid": "t3", "correlationid": "c2", "messageblock": 'asx-diag {"totalMs":90}'},
            {"plugintracelogid": "t4", "correlationid": "c3", "messageblock": 'asx-diag {"totalMs":70}'}]
    lines, duplicates = rs.diag_lines_per_save(rows, exclude={"c3"})
    assert lines == [{"totalMs": 250}, {"totalMs": 90}] and duplicates == 1


def test_record_failed_finds_the_marker_inside_a_wrapped_message():
    rid = "11111111-2222-3333-4444-555555555555"
    text = f"POST asx_ProcessRunPage: 400: Plug-in failed: asx_ProcessRunPage:record-failed:{rid}:Update perf_child1: boom"
    assert rs.record_failed(text) == (rid, "Update perf_child1: boom")
    assert rs.record_failed("POST asx_ProcessRunPage: 500: timeout") is None


def test_drive_run_reports_a_record_failed_page_and_continues():
    rid = "11111111-2222-3333-4444-555555555555"
    sent = []

    def call(payload):
        sent.append(dict(payload))
        if len(sent) == 1:
            raise RuntimeError(f"400: asx_ProcessRunPage:record-failed:{rid}:boom")
        if "FailedRecordId" in payload:           # report-only: processes no records
            return {"Done": False, "Diagnostics": json.dumps({"totalMs": 999, "pageRecords": 0})}
        return {"Done": len(sent) == 3, "Diagnostics": json.dumps({"totalMs": 10, "pageRecords": 1})}

    pages, error = rs.drive_run(call, "run-1", 10)
    assert error is None and pages == [{"totalMs": 10, "pageRecords": 1}]   # the report-only call is no page
    assert sent[1]["FailedRecordId"] == rid and sent[1]["FailedMessage"] == "boom"
    assert "FailedRecordId" not in sent[2] and all(p["IncludeDiagnostics"] is True for p in sent)


def test_drive_run_stops_when_a_report_only_call_ends_the_run():
    # The safety stop can end the run on the report call itself; its diagnostics are still no page.
    rid = "11111111-2222-3333-4444-555555555555"
    sent = []

    def call(payload):
        sent.append(payload)
        if len(sent) == 1:
            return {"Done": False, "Diagnostics": json.dumps({"totalMs": 10, "pageRecords": 1})}
        if len(sent) == 2:
            raise RuntimeError(f"asx_ProcessRunPage:record-failed:{rid}:boom")
        return {"Done": True, "Diagnostics": json.dumps({"totalMs": 999})}

    pages, error = rs.drive_run(call, "run-1", 10)
    assert error is None and len(sent) == 3 and pages == [{"totalMs": 10, "pageRecords": 1}]


def test_drive_run_gives_up_on_a_repeated_record_failed_and_on_too_many_pages():
    def always_failed(payload):
        raise RuntimeError("asx_ProcessRunPage:record-failed:11111111-2222-3333-4444-555555555555:boom")

    pages, error = rs.drive_run(always_failed, "run-1", 10)
    assert pages == [] and "record-failed" in error

    pages, error = rs.drive_run(lambda p: {"Done": False, "Diagnostics": "{}"}, "run-2", 3)
    assert len(pages) == 3 and error == "run run-2 did not finish within 3 pages"


def test_dev_guard_refuses_any_other_target():
    rs.check_dev_target("https://org-dev.crm.dynamics.com/", "https://ORG-DEV.crm.dynamics.com")
    for effective, env in (("https://prod.crm.dynamics.com", "https://org-dev.crm.dynamics.com"), ("x", None)):
        try:
            rs.check_dev_target(effective, env)
            assert False, "expected SystemExit"
        except SystemExit:
            pass


def test_read_env_file_url_reads_only_that_key():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, ".env")
        with open(path, "w", encoding="utf-8") as f:
            f.write("# comment\nCLIENT_SECRET=not-read\nDATAVERSE_URL = https://org-dev.crm.dynamics.com\n")
        assert rs.read_env_file_url(path) == "https://org-dev.crm.dynamics.com"
        assert rs.read_env_file_url(os.path.join(d, "missing")) is None


def test_generate_args_and_roots_per_step():
    assert rs.generate_args("S3", 2000, 5) == ["--records", "5", "--rows-per-root", "2000", "--profile", "S3"]
    assert rs.roots_for_step("S1", 10000, 10) == 5          # 50,000 child rows at most
    assert rs.generate_args("S4", 1000, 5) == ["--records", "1000", "--rows-per-root", "1", "--profile", "S4"]
    assert rs.generate_args("S5", 10, 5) == ["--records", "5", "--rows-per-root", "1", "--profile", "S5", "--profile-step", "10"]
    assert rs.generate_args("S6", 3, 5) == ["--records", "5", "--child-fanout", "3", "--profile", "S6", "--profile-step", "3"]
    assert rs.parse_ladder("100, 500,2000") == [100, 500, 2000]


def test_the_shared_constants_come_from_profiles():
    # P7: one home for the harness constants.
    assert rs.SAVE_SCENARIOS is profiles.SAVE_PROFILES and rs.S3_FIRE_MARKER is profiles.S3_FIRE_MARKER


def test_scheduler_busy_ignores_our_own_heartbeat():
    now = datetime.datetime(2026, 9, 30, 12, 0, tzinfo=datetime.timezone.utc)
    assert rs.scheduler_busy("2026-09-30T11:50:00Z", "flow-user", "me", now) is True
    assert rs.scheduler_busy("2026-09-30T11:50:00Z", "ME", "me", now) is False
    assert rs.scheduler_busy("2026-09-30T11:30:00Z", "flow-user", "me", now) is False
    assert rs.scheduler_busy(None, None, "me", now) is False


def test_write_reports_rebuilds_the_capacity_summary_from_every_scenario():
    with tempfile.TemporaryDirectory() as d:
        ok = {**aggregate.empty_summary(), "samples": 1, "totalMs": 100, "stages": {"queryExecute": 60}}
        rs.write_reports(d, "2026-09-30", "base", "S1", [aggregate.step_result("S1", 100, ok, None)])
        paths = rs.write_reports(d, "2026-09-30", "base", "S3", [aggregate.step_result("S3", 100, ok, "save 1: boom")])
        assert sorted(os.listdir(d)) == ["2026-09-30-base-S1.csv", "2026-09-30-base-S1.json", "2026-09-30-base-S1.md",
                                         "2026-09-30-base-S3.csv", "2026-09-30-base-S3.json", "2026-09-30-base-S3.md",
                                         "2026-09-30-base-capacity.md"]
        capacity = open(paths[-1], encoding="utf-8").read()
        assert "| S1 | 100 | none (every step passed) |" in capacity and "| S3 | none | 100 | save 1: boom |" in capacity


def _noop(*_):
    pass


def test_a_failing_step_reset_is_a_setup_failure_and_earlier_steps_are_still_reported():
    ops = FakeOps(reset_fails_on={2})
    with tempfile.TemporaryDirectory() as d:
        results, paths = rs.run_and_report(ops, "S1", [100, 500, 2000], 5, d, "base",
                                           today=lambda: datetime.date(2026, 9, 30), log=_noop)
        assert [(r["step"], r["passed"]) for r in results] == [("100", True), ("500", False)]
        assert results[1]["error"].startswith("setup: reset-data.py failed")
        assert ("prepare", 500) not in ops.calls and ops.calls[-1] == ("reset",)   # the final reset still ran
        with open(os.path.join(d, "2026-09-30-base-S1.json"), encoding="utf-8") as f:
            assert [r["step"] for r in json.load(f)] == ["100", "500"]


def test_a_failing_final_reset_is_logged_and_the_results_are_still_reported():
    ops = FakeOps(reset_fails_on={3}, trace=0)
    logged = []
    with tempfile.TemporaryDirectory() as d:
        results, paths = rs.run_and_report(ops, "S3", [100, 500], 5, d, "base",
                                           today=lambda: datetime.date(2026, 9, 30), log=logged.append)
        assert [(r["step"], r["passed"]) for r in results] == [("100", True), ("500", True)]
        assert any("final reset failed" in line and "reset-data.py failed" in line for line in logged)
        assert ops.calls[-1] == ("set_trace", 0)                                 # tracing restored anyway
        assert os.path.exists(os.path.join(d, "2026-09-30-base-S3.json")) and paths[-1].endswith("capacity.md")


def test_an_interrupted_run_still_reports_the_steps_it_finished():
    ops = FakeOps(interrupt_at=500)
    with tempfile.TemporaryDirectory() as d:
        try:
            rs.run_and_report(ops, "S2", [100, 500, 2000], 5, d, "base",
                              today=lambda: datetime.date(2026, 9, 30), log=_noop)
            assert False, "expected KeyboardInterrupt"
        except KeyboardInterrupt:
            pass
        with open(os.path.join(d, "2026-09-30-base-S2.json"), encoding="utf-8") as f:
            assert [r["step"] for r in json.load(f)] == ["100"]
        assert os.path.exists(os.path.join(d, "2026-09-30-base-capacity.md"))


def test_a_ladder_that_crosses_midnight_is_reported_under_its_start_date():
    clock = FakeClock()
    clock.t = datetime.datetime(2026, 9, 30, 23, 59, 30, tzinfo=datetime.timezone.utc).timestamp()

    def today():
        return datetime.datetime.fromtimestamp(clock.t, datetime.timezone.utc).date()

    with tempfile.TemporaryDirectory() as d:
        rs.run_and_report(FakeOps(clock=clock), "S5", [1, 10], 5, d, "base", today=today, log=_noop)
        assert today() == datetime.date(2026, 10, 1)
        assert sorted(os.listdir(d)) == ["2026-09-30-base-S5.csv", "2026-09-30-base-S5.json",
                                         "2026-09-30-base-S5.md", "2026-09-30-base-capacity.md"]


# ---------------------------------------------------------------------------
# DataverseOps against a fake Dataverse client (no network)
# ---------------------------------------------------------------------------

START = datetime.datetime(2026, 9, 30, 12, 0, tzinfo=datetime.timezone.utc).timestamp()


class FakeClock:
    def __init__(self):
        self.t = START

    def time(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds

    def iso(self, offset=0.0):
        return datetime.datetime.fromtimestamp(self.t + offset, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class FakeDv:
    """Just enough of _dv for DataverseOps: request() routed by path, with an in-memory plugintracelogs.
    on_save(root_id, payload) returns the messageblocks the engine plug-in traces for that PATCH."""

    class DataverseError(Exception):
        def __init__(self, method, path, status, message):
            super().__init__(f"{method} {path}: {status}: {message}")
            self.status, self.message = status, message

    def __init__(self, clock, roots=3, on_save=None, schedules=None, status=None):
        self.clock = clock
        self.roots = [{"perf_rootid": f"root-{i}", "_perf_lookup1id_value": "l1-0"} for i in range(roots)]
        self.pool = [{"perf_lookup1id": f"l1-{i}"} for i in range(4)]
        self.on_save = on_save or (lambda root_id, payload: ['asx-diag {"totalMs":100}'])
        self.schedules = schedules or (lambda: [])
        self.status = status or []
        self.traces = [{"plugintracelogid": "old", "correlationid": "old", "createdon": clock.iso(-3600),
                        "messageblock": 'asx-diag {"totalMs":1}'}]     # a previous step's line
        self.saves = []
        self.posts = []
        self._n = 0

    def whoami(self):
        return {"UserId": "me"}

    def resolve_nav_property(self, entity, referenced, attribute):
        return "perf_lookup1id"

    def request(self, method, path, payload=None, *, solution=False, timeout=180):
        path = urllib.parse.unquote(path)
        self.clock.sleep(1)                                    # every call takes a second
        if method == "PATCH" and path.startswith("perf_roots("):
            root_id = path[len("perf_roots("):-1]
            self.saves.append((root_id, payload))
            self._n += 1
            for block in self.on_save(root_id, payload):
                self.traces.append({"plugintracelogid": f"t{len(self.traces)}", "correlationid": f"c{self._n}",
                                    "createdon": self.clock.iso(), "messageblock": block})
            return {}, None
        if method == "POST":
            self.posts.append((path, payload))
            if path == "asx_StartDueSchedules":
                return {}, {"Diagnostics": json.dumps({"totalMs": 900, "schedulesStarted": 1})}
            raise AssertionError(f"unexpected POST {path}")
        if path.startswith("perf_roots?"):
            return {}, {"value": [dict(r) for r in self.roots]}
        if path.startswith("perf_lookup1s?"):
            return {}, {"value": self.pool}
        if path.startswith("plugintracelogs?") and "createdon desc" in path:
            return {}, {"value": sorted(self.traces, key=lambda r: r["createdon"])[-1:][::-1]}
        if path.startswith("plugintracelogs?"):
            op, since = re.search(r"createdon (gt|ge) (\S+)", path).groups()
            keep = [r for r in self.traces if (r["createdon"] > since if op == "gt" else r["createdon"] >= since)]
            return {}, {"value": sorted(keep, key=lambda r: r["createdon"])}
        if path.startswith("asx_ruleschedules?"):
            return {}, {"value": self.schedules()}
        if path.startswith("asx_schedulerstatuses?"):
            return {}, {"value": self.status}
        raise AssertionError(f"unexpected {method} {path}")


def _ops(dv, clock, trace_settle=60):
    return rs.DataverseOps(rs.REPO_ROOT, trace_settle, log=lambda *_: None, dv=dv, clock=clock.time, sleep=clock.sleep)


def test_s3_probes_until_enforcement_settles_then_measures_only_the_real_saves():
    # P2: the first probe save leaves no asx-diag line (enforcement not live yet); the second does.
    clock = FakeClock()
    probes = []

    def on_save(root_id, payload):
        if profiles.S3_FIRE_MARKER not in payload["perf_text"]:
            probes.append(root_id)
            return [] if len(probes) == 1 else ['asx-diag {"totalMs":5}']
        return ['[+1ms] - Render language: 1033.\nasx-diag {"totalMs":400,"writesSent":2}']

    dv = FakeDv(clock, roots=3, on_save=on_save)
    [result] = _ops(dv, clock).drive("S3", 100, 3)
    assert result["passed"], result["error"]
    assert probes == ["root-0", "root-0"]
    measured = [p for _, p in dv.saves if profiles.S3_FIRE_MARKER in p["perf_text"]]
    assert [p["perf_text"] for p in measured] == ["S3FIRE-0", "S3FIRE-1", "S3FIRE-2"]
    assert result["summary"]["samples"] == 3 and result["summary"]["totalMs"] == 400   # the probe lines are not counted


def test_a_step_whose_probe_never_produces_a_line_fails_before_measuring():
    clock = FakeClock()
    dv = FakeDv(clock, on_save=lambda root_id, payload: [])
    [result] = _ops(dv, clock, trace_settle=60).drive("S3", 100, 3)
    assert not result["passed"] and result["error"].startswith("enforcement did not settle")
    assert dv.saves and not any(profiles.S3_FIRE_MARKER in p["perf_text"] for _, p in dv.saves)
    assert clock.time() - START < 120                           # gave up after about --trace-settle


def test_s2_counts_one_line_per_save_and_changes_each_root_to_another_lookup():
    # P14: the engine plug-in runs twice for every measured save; each save counts once, the slower line kept.
    clock = FakeClock()
    dv = FakeDv(clock, roots=3,
                on_save=lambda root_id, payload: ['asx-diag {"totalMs":300}', 'asx-diag {"totalMs":120}'])
    [result] = _ops(dv, clock).drive("S2", 100, 3)
    assert result["passed"], result["error"]
    assert result["summary"]["samples"] == 3 and result["summary"]["totalMs"] == 300
    assert result["duplicateDiagLines"] == 3
    current = {"root-0": "l1-0", "root-1": "l1-0", "root-2": "l1-0"}
    for root_id, payload in dv.saves:                           # the probe too: every save changes the lookup
        target = payload["perf_lookup1id@odata.bind"]
        assert target != f"/perf_lookup1s({current[root_id]})"
        current[root_id] = target[len("/perf_lookup1s("):-1]


def _s3_lines(kept):
    """on_save for S3: every probe traces a line; measured save n (1-based) traces what kept(n) returns."""
    measured = []

    def on_save(root_id, payload):
        if profiles.S3_FIRE_MARKER not in payload["perf_text"]:
            return ['asx-diag {"totalMs":5}']
        measured.append(payload)
        return kept(len(measured))
    return on_save


def test_a_step_passes_on_the_saves_whose_line_dataverse_kept():
    # R6: Dataverse drops some trace rows even with tracing on All; 3 of 5 lines is enough.
    clock = FakeClock()
    dv = FakeDv(clock, roots=5, on_save=_s3_lines(lambda n: [] if n in (2, 4) else [f'asx-diag {{"totalMs":{n}00}}']))
    [result] = _ops(dv, clock).drive("S3", 100, 5)
    assert result["passed"] and result["diagCaptured"] == "3/5"
    assert result["summary"]["samples"] == 3 and result["summary"]["totalMs"] == 300


def test_a_step_with_fewer_than_half_of_its_lines_fails_with_an_accurate_count():
    # R6 and P10: under half captured fails; an unparseable line counts as missing.
    clock = FakeClock()
    dv = FakeDv(clock, roots=5, on_save=_s3_lines(
        lambda n: [] if n in (2, 4) else ['asx-diag {"totalMs":' if n == 5 else 'asx-diag {"totalMs":100}']))
    [result] = _ops(dv, clock).drive("S3", 100, 5)
    assert result["error"] == "found 2 of 5 asx-diag lines in plugintracelogs" and result["diagCaptured"] == "2/5"
    assert result["summary"]["samples"] == 2


def test_reading_the_lines_back_stops_as_soon_as_every_save_is_captured():
    clock = FakeClock()
    dv = FakeDv(clock, roots=5, on_save=_s3_lines(lambda n: ['asx-diag {"totalMs":100}']))
    [result] = _ops(dv, clock).drive("S3", 100, 5)
    assert result["passed"] and result["diagCaptured"] == "5/5"
    assert clock.time() - START < 30                            # not the 180-second read window


def test_save_scenarios_sample_ten_roots_by_default():
    assert [rs.default_sample(s) for s in rs.SCENARIOS] == [5, 10, 10, 5, 5, 5]


def test_a_failed_measured_save_waits_only_for_the_saves_that_succeeded():
    clock = FakeClock()

    def on_save(root_id, payload):
        if payload["perf_text"] == "S3FIRE-1":
            raise FakeDv.DataverseError("PATCH", f"perf_roots({root_id})", 500, "plug-in timed out")
        return ['asx-diag {"totalMs":100}']

    dv = FakeDv(clock, roots=3, on_save=on_save)
    [result] = _ops(dv, clock).drive("S3", 100, 3)
    assert result["error"].startswith("save 2: PATCH perf_roots(root-1)")
    assert result["summary"]["samples"] == 1 and result["diagCaptured"] == "1/2"
    assert clock.time() - START < 60                            # no 180-second poll for a line that can't come


def test_s5_treats_a_null_next_run_on_as_not_yet_due_and_keeps_waiting():
    # P14: a schedule whose Next run on is not set yet is not due; the driver waits instead of crashing.
    clock = FakeClock()
    reads = []

    def schedules():
        reads.append(clock.time())
        due = None if len(reads) < 3 else clock.iso(-120)
        return [{"asx_nextrunon": due}, {"asx_nextrunon": clock.iso(-300)}]

    dv = FakeDv(clock, schedules=schedules)
    [result] = _ops(dv, clock).drive("S5", 2, 5)
    assert len(reads) == 3 and [p for p, _ in dv.posts] == ["asx_StartDueSchedules"]
    assert result["step"] == "2" and result["summary"]["counters"]["schedulesStarted"] == 1


def test_s5_gives_up_when_next_run_on_stays_null_past_the_wait_cap():
    clock = FakeClock()
    dv = FakeDv(clock, schedules=lambda: [{"asx_nextrunon": None}])
    try:
        _ops(dv, clock).drive("S5", 1, 5)
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "no Next run on" in str(e)
    assert not dv.posts and clock.time() - START <= 21 * 60


def test_s5_refuses_while_another_callers_scheduler_heartbeat_is_fresh():
    clock = FakeClock()
    dv = FakeDv(clock, status=[{"asx_lastseenon": clock.iso(-300), "_asx_lastseenby_value": "flow-user"}])
    ops = _ops(dv, clock)
    for attempt in (ops.check_scheduler_idle, lambda: ops.drive("S5", 1, 5)):
        try:
            attempt()
            assert False, "expected RuntimeError"
        except RuntimeError as e:
            assert "Rules Engine Scheduler" in str(e)
    assert not dv.posts


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("OK")
