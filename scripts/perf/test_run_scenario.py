"""Unit tests for run-scenario.py's step logic with a fake Dataverse. Run: python scripts/perf/test_run_scenario.py"""
import datetime
import http.client
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


SWITCH = {"definitionId": "def-1", "defaultValue": "no", "valueId": None, "value": None}


class FakeOps:
    """Records every call; drive() passes (100 ms) unless told to fail, raise or be interrupted."""

    def __init__(self, fail_at=None, raise_at=None, interrupt_at=None, setup_fails_at=None, switch=SWITCH,
                 reset_fails_on=(), clock=None):
        self.calls = []
        self.fail_at, self.raise_at, self.interrupt_at, self.setup_fails_at = fail_at, raise_at, interrupt_at, setup_fails_at
        self.switch = switch
        self.reset_fails_on = reset_fails_on      # which reset calls (1-based) fail, the final reset included
        self.clock = clock                        # when given, every drive takes a minute

    def reset(self):
        self.calls.append(("reset",))
        if sum(1 for c in self.calls if c == ("reset",)) in self.reset_fails_on:
            raise RuntimeError("reset-data.py failed: ERROR DELETE perf_roots(x): 500")

    def prepare(self, scenario, step, sample, rules=None):
        self.calls.append(("prepare", step) if rules is None else ("prepare", step, rules))
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

    def read_capture_switch(self):
        self.calls.append(("read_switch",))
        return self.switch

    def switch_capture_on(self, state):
        self.calls.append(("switch_on", state))

    def restore_capture_switch(self, state):
        self.calls.append(("restore_switch", state))


def _touches_switch(calls):
    return any(c[0] in ("read_switch", "switch_on", "restore_switch") for c in calls)


def test_stops_at_the_first_failing_step_and_resets_between_and_after():
    ops = FakeOps(fail_at=500)
    results = rs.run(ops, "S1", [100, 500, 2000], 5, log=lambda *_: None)
    assert [(r["step"], r["passed"]) for r in results] == [("100", True), ("500", False)]
    assert results[1]["error"] == "median totalMs 3000 > 2000"
    assert ("prepare", 2000) not in ops.calls
    assert [c for c in ops.calls if c[0] == "reset"] == [("reset",)] * 3
    assert ops.calls[0] == ("reset",) and ops.calls[-1] == ("reset",)


def test_only_the_save_scenarios_touch_the_capture_switch():
    for scenario in ("S1", "S4", "S5", "S6"):
        ops = FakeOps()
        rs.run(ops, scenario, [1], 5, log=lambda *_: None)
        assert not _touches_switch(ops.calls), scenario


def test_save_scenarios_turn_the_capture_switch_on_and_restore_it():
    ops = FakeOps()
    rs.run(ops, "S3", [100], 5, log=lambda *_: None)
    assert ops.calls[:2] == [("read_switch",), ("switch_on", SWITCH)]
    assert ops.calls[-2:] == [("reset",), ("restore_switch", SWITCH)]


def test_save_scenarios_restore_the_capture_switch_even_when_interrupted():
    ops = FakeOps(interrupt_at=500)
    try:
        rs.run(ops, "S2", [100, 500, 2000], 5, log=lambda *_: None)
        assert False, "expected KeyboardInterrupt"
    except KeyboardInterrupt:
        pass
    assert ("switch_on", SWITCH) in ops.calls
    assert ops.calls[-2:] == [("reset",), ("restore_switch", SWITCH)]


def test_save_scenarios_restore_the_capture_switch_after_a_failed_step():
    ops = FakeOps(raise_at=500)
    results = rs.run(ops, "S3", [100, 500, 2000], 5, log=lambda *_: None)
    assert [r["passed"] for r in results] == [True, False]
    assert ops.calls[-1] == ("restore_switch", SWITCH)


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


def _row(rid, record, diag, created="2026-09-30T12:00:00Z"):
    return {"asx_rulediagnosticid": rid, "asx_recordid": record, "asx_diagnostics": diag, "createdon": created}


def test_diagnostics_per_save_keeps_one_row_per_saved_record_the_slowest():
    # P14: two engine executions of one save (same record) count once, keeping the larger totalMs.
    rows = [_row("d1", "root-1", '{"totalMs":100}'), _row("d2", "ROOT-1", '{"totalMs":250}'),
            _row("d3", "root-2", '{"totalMs":90}'), _row("d4", "root-3", '{"totalMs":70}')]
    per_save, duplicates = rs.diagnostics_per_save(rows, exclude={"d4"})
    assert per_save == {"root-1": {"totalMs": 250}, "root-2": {"totalMs": 90}} and duplicates == 1


def test_diagnostics_per_save_skips_a_row_that_does_not_parse():
    # P10: a garbled asx_diagnostics value is skipped (counted as missing), never a crash.
    rows = [_row("d1", "root-1", '{"totalMs":120,"stages":[{"name":"queryEx'), _row("d2", "root-2", "[1, 2]"),
            _row("d3", "root-3", None), _row("d4", "root-4", '{"totalMs":80}')]
    assert rs.diagnostics_per_save(rows) == ({"root-4": {"totalMs": 80}}, 0)


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


def test_generate_args_pass_the_background_rule_count_only_when_given():
    assert rs.generate_args("S1", 100, 5, rules=0) == ["--records", "5", "--rows-per-root", "100", "--profile", "S1",
                                                       "--rules", "0"]
    assert "--rules" not in rs.generate_args("S6", 3, 5)
    assert rs.parse_args(["--scenario", "S1", "--rules", "0"]).rules == 0
    assert rs.parse_args(["--scenario", "S1"]).rules is None


def test_every_step_records_its_background_rule_count():
    ops = FakeOps(setup_fails_at=500)
    results = rs.run(ops, "S1", [100, 500], 5, log=lambda *_: None, rules=0)
    assert ("prepare", 100, 0) in ops.calls
    assert [(r["step"], r["backgroundRules"]) for r in results] == [("100", 0), ("500", 0)]
    # Without --rules a step records the profile's default, the count generate.py then uses.
    for scenario, default in (("S1", 100), ("S3", 0)):
        [result] = rs.run(FakeOps(), scenario, [100], 5, log=lambda *_: None)
        assert result["backgroundRules"] == default == profiles.DEFAULT_BACKGROUND[scenario]


def test_the_report_names_the_background_rule_count():
    with tempfile.TemporaryDirectory() as d:
        rs.run_and_report(FakeOps(), "S1", [100], 5, d, "base", today=lambda: datetime.date(2026, 9, 30),
                          log=_noop, rules=0)
        with open(os.path.join(d, "2026-09-30-base-S1.json"), encoding="utf-8") as f:
            assert json.load(f)[0]["backgroundRules"] == 0
        with open(os.path.join(d, "2026-09-30-base-S1.md"), encoding="utf-8") as f:
            assert "Background rules: 0" in f.read()


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


def _ok(scenario, step, total=100, error=None):
    return aggregate.step_result(scenario, step, {**aggregate.empty_summary(), "samples": 1, "totalMs": total,
                                                  "stages": {"queryExecute": total}}, error)


def _json_steps(d, scenario):
    with open(os.path.join(d, f"2026-09-30-base-{scenario}.json"), encoding="utf-8") as f:
        return [(r["step"], r["passed"], r["summary"]["totalMs"]) for r in json.load(f)]


def test_a_partial_rerun_merges_into_the_scenario_report_by_step():
    with tempfile.TemporaryDirectory() as d:
        rs.write_reports(d, "2026-09-30", "base", "S1",
                         [_ok("S1", 100), _ok("S1", 500), _ok("S1", 2000, 3000, "median totalMs 3000 > 2000")])
        # A later run of only the top of the ladder replaces 2000 and adds 5000; 100 and 500 are kept.
        paths = rs.write_reports(d, "2026-09-30", "base", "S1",
                                 [_ok("S1", 2000, 900), _ok("S1", 5000, 2500, "median totalMs 2500 > 2000")])
        assert _json_steps(d, "S1") == [("100", True, 100), ("500", True, 100), ("2000", True, 900),
                                         ("5000", False, 2500)]
        md = open(paths[0], encoding="utf-8").read()
        assert "| 500 | pass |" in md and "| 2000 | pass | 1 | 900 |" in md and "| 5000 | fail |" in md
        with open(paths[1], encoding="utf-8") as f:
            assert [row.split(",")[1] for row in f.read().splitlines()[1:]] == ["100", "500", "2000", "5000"]
        capacity = open(paths[-1], encoding="utf-8").read()
        assert "| S1 | 2000 | 5000 | median totalMs 2500 > 2000 |" in capacity
        # Re-running a lower step alone keeps the ladder order.
        rs.write_reports(d, "2026-09-30", "base", "S1", [_ok("S1", 500, 700)])
        assert [s for s, _, _ in _json_steps(d, "S1")] == ["100", "500", "2000", "5000"]
        assert _json_steps(d, "S1")[1] == ("500", True, 700)


def test_a_rerun_s4_step_replaces_both_of_its_variant_rows():
    # S4 reports a ladder step as <step>:no-writes and <step>:set-update; a re-run that stops at the first
    # variant must not leave the old second variant behind.
    with tempfile.TemporaryDirectory() as d:
        rs.write_reports(d, "2026-09-30", "base", "S4",
                         [_ok("S4", "1000:no-writes"), _ok("S4", "1000:set-update"), _ok("S4", "10000:no-writes")])
        rs.write_reports(d, "2026-09-30", "base", "S4", [_ok("S4", "1000:no-writes", 50, "boom")])
        assert [s for s, _, _ in _json_steps(d, "S4")] == ["1000:no-writes", "10000:no-writes"]


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
    ops = FakeOps(reset_fails_on={3})
    logged = []
    with tempfile.TemporaryDirectory() as d:
        results, paths = rs.run_and_report(ops, "S3", [100, 500], 5, d, "base",
                                           today=lambda: datetime.date(2026, 9, 30), log=logged.append)
        assert [(r["step"], r["passed"]) for r in results] == [("100", True), ("500", True)]
        assert any("final reset failed" in line and "reset-data.py failed" in line for line in logged)
        assert ops.calls[-1] == ("restore_switch", SWITCH)                       # the switch restored anyway
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


UNSAFE_URL = re.compile(r"[\x00-\x20\x7f]")                 # http.client._contains_disallowed_url_pchar_re


class FakeDv:
    """Just enough of _dv for DataverseOps: request() routed by path, with in-memory asx_rulediagnostic rows and
    the asx_CaptureDiagnostics definition and value rows. on_save(root_id, payload) returns the diagnostics JSON
    of each asx_rulediagnostic row the engine plug-in writes for that PATCH (rows are written inside the save)."""

    class DataverseError(Exception):
        def __init__(self, method, path, status, message):
            super().__init__(f"{method} {path}: {status}: {message}")
            self.status, self.message = status, message

    def __init__(self, clock, roots=3, on_save=None, schedules=None, status=None, values=None, defined=True):
        self.clock = clock
        self.roots = [{"perf_rootid": f"root-{i}", "_perf_lookup1id_value": "l1-0"} for i in range(roots)]
        self.pool = [{"perf_lookup1id": f"l1-{i}"} for i in range(4)]
        self.on_save = on_save or (lambda root_id, payload: ['{"totalMs":100}'])
        self.schedules = schedules or (lambda: [])
        self.status = status or []
        self.diagnostics = [{"asx_rulediagnosticid": "old", "asx_tablelogicalname": "perf_root",
                             "asx_recordid": "root-0", "createdon": clock.iso(-3600),
                             "asx_diagnostics": '{"totalMs":1}'}]           # a row the step's generate left
        self.definitions = [{"environmentvariabledefinitionid": "def-1", "defaultvalue": "no"}] if defined else []
        self.values = [dict(v) for v in (values or [])]
        self.switch_writes = []                                   # (method, path, payload) on environmentvariablevalues
        self.fail_value_post = False                              # POST creates the row, then times out
        self.saves = []
        self.posts = []
        self.paths = []

    def whoami(self):
        return {"UserId": "me"}

    def resolve_nav_property(self, entity, referenced, attribute):
        return {("perf_root", "perf_lookup1", "perf_lookup1id"): "perf_lookup1id",
                ("environmentvariablevalue", "environmentvariabledefinition", "environmentvariabledefinitionid"):
                    "EnvironmentVariableDefinitionId",
                ("asx_rulerun", "asx_rule", "asx_rule"): "asx_RuleId"}[(entity, referenced, attribute)]

    def _switch_values(self, method, path, payload):
        if method == "GET":
            definition = re.search(r"_environmentvariabledefinitionid_value eq ([^&\s]+)", path).group(1)
            return {}, {"value": [dict(v) for v in self.values
                                  if v["_environmentvariabledefinitionid_value"] == definition]}
        self.switch_writes.append((method, path, payload))
        if method == "POST":
            bind = payload["EnvironmentVariableDefinitionId@odata.bind"]
            assert bind.startswith("/environmentvariabledefinitions(") and payload["schemaname"] == "asx_CaptureDiagnostics"
            self.values.append({"environmentvariablevalueid": "val-new", "value": payload["value"], "statecode": 0,
                                "_environmentvariabledefinitionid_value": bind[len("/environmentvariabledefinitions("):-1]})
            if self.fail_value_post:
                raise FakeDv.DataverseError(method, path, None, "timed out")
            return {"OData-EntityId": "https://x/api/data/v9.2/environmentvariablevalues(val-new)"}, None
        value_id = path[len("environmentvariablevalues("):-1]
        [row] = [v for v in self.values if v["environmentvariablevalueid"] == value_id]
        if method == "PATCH":
            row.update(payload)
        else:
            self.values.remove(row)
        return {}, None

    def request(self, method, path, payload=None, *, solution=False, timeout=180):
        if UNSAFE_URL.search(path):                             # what http.client refuses before sending
            raise http.client.InvalidURL(f"URL can't contain control characters. {path!r}")
        self.paths.append(path)
        path = urllib.parse.unquote(path)
        self.clock.sleep(1)                                    # every call takes a second
        if method == "PATCH" and path.startswith("perf_roots("):
            root_id = path[len("perf_roots("):-1]
            self.saves.append((root_id, payload))
            for diag in self.on_save(root_id, payload):
                self.diagnostics.append({"asx_rulediagnosticid": f"d{len(self.diagnostics)}",
                                         "asx_tablelogicalname": "perf_root", "asx_recordid": root_id,
                                         "createdon": self.clock.iso(), "asx_diagnostics": diag})
            return {}, None
        if path.startswith("environmentvariablevalues"):
            return self._switch_values(method, path, payload)
        if method == "POST":
            self.posts.append((path, payload))
            if path == "asx_StartDueSchedules":
                return {}, {"Diagnostics": json.dumps({"totalMs": 900, "schedulesStarted": 1})}
            if path == "asx_RunRules":
                return {}, {"Diagnostics": json.dumps({"totalMs": 120})}
            if path == "asx_ruleruns":
                return {"OData-EntityId": f"https://x/api/data/v9.2/asx_ruleruns(run-{len(self.posts)})"}, None
            if path == "asx_ProcessRunPage":
                return {}, {"Done": True, "Diagnostics": json.dumps({"totalMs": 50, "pageRecords": 1})}
            raise AssertionError(f"unexpected POST {path}")
        if path.startswith("asx_rules?"):
            return {}, {"value": [{"asx_ruleid": "rule-1"}]}
        if path.startswith("environmentvariabledefinitions?"):
            assert "schemaname eq 'asx_CaptureDiagnostics'" in path
            return {}, {"value": self.definitions}
        if path.startswith("perf_roots?"):
            return {}, {"value": [dict(r) for r in self.roots]}
        if path.startswith("perf_lookup1s?"):
            return {}, {"value": self.pool}
        if path.startswith("asx_rulediagnostics?"):
            assert "asx_tablelogicalname eq 'perf_root'" in path
            ids = set(re.findall(r"asx_recordid eq '([^']+)'", path))
            since = re.search(r"createdon ge ([^&\s]+)", path)
            keep = [dict(r) for r in self.diagnostics
                    if r["asx_recordid"] in ids and (since is None or r["createdon"] >= since.group(1))]
            return {}, {"value": sorted(keep, key=lambda r: r["createdon"])}
        if path.startswith("asx_ruleschedules?"):
            return {}, {"value": self.schedules()}
        if path.startswith("asx_schedulerstatuses?"):
            return {}, {"value": self.status}
        raise AssertionError(f"unexpected {method} {path}")


def _ops(dv, clock, settle=60):
    return rs.DataverseOps(rs.REPO_ROOT, settle, log=lambda *_: None, dv=dv, clock=clock.time, sleep=clock.sleep)


def test_the_fake_client_refuses_a_url_that_urlopen_would_refuse():
    clock = FakeClock()
    for bad in ("perf_roots?$filter=perf_name eq 'x'", "perf_roots?$top=1\n"):
        try:
            FakeDv(clock).request("GET", bad)
            assert False, "expected InvalidURL"
        except http.client.InvalidURL:
            pass


def test_every_request_the_driver_builds_is_url_safe():
    # The switch with a value row (patch, restore) and without one (create, find afresh, delete), then every
    # scenario's drive. FakeDv raises InvalidURL on a raw space, as urlopen does on DEV.
    clock = FakeClock()
    for values in ([], [_value("no")]):
        dv = FakeDv(clock, values=values)
        ops = _ops(dv, clock)
        state = ops.read_capture_switch()
        ops.switch_capture_on(state)
        ops.restore_capture_switch(state)
    dv = FakeDv(clock, roots=2, schedules=lambda: [{"asx_nextrunon": clock.iso(-120)}])
    ops = _ops(dv, clock)
    for scenario, step in (("S1", 100), ("S2", 100), ("S3", 100), ("S4", 1000), ("S5", 1), ("S6", 1)):
        results = ops.drive(scenario, step, 2)
        assert all(r["passed"] for r in results), (scenario, [r["error"] for r in results])
    assert any(p.startswith("asx_rules?") for p in dv.paths) and any(p.startswith("asx_rulediagnostics?") for p in dv.paths)


def test_prepare_passes_the_background_rule_count_to_generate():
    clock = FakeClock()
    ops = _ops(FakeDv(clock), clock)
    scripts = []
    ops._script = lambda name, args: scripts.append((name, args))
    ops.prepare("S6", 3, 5, 0)
    ops.prepare("S6", 3, 5)
    assert scripts[0] == ("generate.py", rs.generate_args("S6", 3, 5, 0)) and scripts[0][1][-2:] == ["--rules", "0"]
    assert "--rules" not in scripts[1][1]


# -- asx_CaptureDiagnostics: switched on for S2/S3 and restored exactly ----------

def _value(value="no", statecode=0, vid="val-1"):
    return {"environmentvariablevalueid": vid, "value": value, "statecode": statecode,
            "_environmentvariabledefinitionid_value": "def-1"}


def test_the_switch_without_a_value_row_gets_one_created_then_deleted():
    clock = FakeClock()
    dv = FakeDv(clock)
    ops = _ops(dv, clock)
    state = ops.read_capture_switch()
    assert state == {"definitionId": "def-1", "defaultValue": "no", "valueId": None, "value": None}
    ops.switch_capture_on(state)
    [(method, path, payload)] = dv.switch_writes
    assert (method, path) == ("POST", "environmentvariablevalues") and payload["value"] == "yes"
    assert payload["EnvironmentVariableDefinitionId@odata.bind"] == "/environmentvariabledefinitions(def-1)"
    assert [v["value"] for v in dv.values] == ["yes"]
    ops.restore_capture_switch(state)
    assert dv.switch_writes[-1][:2] == ("DELETE", "environmentvariablevalues(val-new)") and dv.values == []


def test_the_switch_with_a_value_row_is_patched_to_yes_then_back():
    clock = FakeClock()
    dv = FakeDv(clock, values=[_value("no")])
    ops = _ops(dv, clock)
    state = ops.read_capture_switch()
    assert state["valueId"] == "val-1" and state["value"] == "no"
    ops.switch_capture_on(state)
    assert dv.values[0]["value"] == "yes"
    ops.restore_capture_switch(state)
    assert dv.switch_writes == [("PATCH", "environmentvariablevalues(val-1)", {"value": "yes"}),
                                ("PATCH", "environmentvariablevalues(val-1)", {"value": "no"})]
    assert dv.values == [_value("no")]


def test_a_value_row_created_by_a_post_that_timed_out_is_still_deleted():
    clock = FakeClock()
    dv = FakeDv(clock)
    dv.fail_value_post = True
    ops = _ops(dv, clock)
    state = ops.read_capture_switch()
    try:
        ops.switch_capture_on(state)
        assert False, "expected DataverseError"
    except FakeDv.DataverseError:
        pass
    ops.restore_capture_switch(state)
    assert dv.values == []


def test_the_switch_is_refused_when_it_is_missing_inactive_or_doubled():
    clock = FakeClock()
    for dv, expected in ((FakeDv(clock, defined=False), "Configure-RuleAuthoring.ps1 -Phase Schema"),
                         (FakeDv(clock, values=[_value("yes", statecode=1)]), "inactive"),
                         (FakeDv(clock, values=[_value("no"), _value("yes", vid="val-2")]), "2 value rows")):
        try:
            _ops(dv, clock).read_capture_switch()
            assert False, "expected RuntimeError"
        except RuntimeError as e:
            assert expected in str(e), str(e)
        assert not dv.switch_writes


class _LadderOps(rs.DataverseOps):
    """The real switch handling against FakeDv; reset, prepare and drive stubbed (no scripts, no saves)."""

    def __init__(self, dv, clock, drive):
        super().__init__(rs.REPO_ROOT, 60, log=lambda *_: None, dv=dv, clock=clock.time, sleep=clock.sleep)
        self._stub_drive = drive
        self.switch_seen = []

    def reset(self):
        pass

    def prepare(self, scenario, step, sample, rules=None):
        pass

    def drive(self, scenario, step, sample):
        self.switch_seen.append([v["value"] for v in self._dv.values])
        return self._stub_drive(scenario, step)


def _interrupt(scenario, step):
    raise KeyboardInterrupt()


def test_an_interrupted_save_run_restores_the_switch_exactly():
    for before in ([], [_value("no")], [_value("", vid="val-9")]):
        clock = FakeClock()
        dv = FakeDv(clock, values=before)
        ops = _LadderOps(dv, clock, _interrupt)
        try:
            rs.run(ops, "S2", [100], 5, log=lambda *_: None)
            assert False, "expected KeyboardInterrupt"
        except KeyboardInterrupt:
            pass
        assert ops.switch_seen == [["yes"]] and dv.values == before


def test_a_failed_save_step_restores_the_switch_exactly():
    def fail(scenario, step):
        return [aggregate.step_result(scenario, step, None, "found 4 of 5 diagnostics rows")]

    clock = FakeClock()
    dv = FakeDv(clock)
    ops = _LadderOps(dv, clock, fail)
    results = rs.run(ops, "S3", [100, 500], 5, log=lambda *_: None)
    assert [r["passed"] for r in results] == [False] and ops.switch_seen == [["yes"]] and dv.values == []


# -- S2, S3: probe until enforcement settles, then one diagnostics row per save ----

def test_s3_probes_until_enforcement_settles_then_measures_only_the_real_saves():
    # The first probe save writes no row (the switch or the step's rules aren't live yet); the second does.
    # Neither the row generate left for root-0 nor the probe's own row is counted.
    clock = FakeClock()
    probes = []

    def on_save(root_id, payload):
        if profiles.S3_FIRE_MARKER not in payload["perf_text"]:
            probes.append(root_id)
            return [] if len(probes) == 1 else ['{"totalMs":5}']
        return ['{"totalMs":400,"writesSent":2}']

    dv = FakeDv(clock, roots=3, on_save=on_save)
    [result] = _ops(dv, clock).drive("S3", 100, 3)
    assert result["passed"], result["error"]
    assert probes == ["root-0", "root-0"]
    measured = [p for _, p in dv.saves if profiles.S3_FIRE_MARKER in p["perf_text"]]
    assert [p["perf_text"] for p in measured] == ["S3FIRE-0", "S3FIRE-1", "S3FIRE-2"]
    assert result["summary"]["samples"] == 3 and result["summary"]["totalMs"] == 400
    assert result["diagCaptured"] == "3/3"


def test_a_step_whose_probe_never_writes_a_row_fails_before_measuring():
    clock = FakeClock()
    dv = FakeDv(clock, on_save=lambda root_id, payload: [])
    [result] = _ops(dv, clock, settle=60).drive("S3", 100, 3)
    assert result["error"] == "enforcement did not settle: no diagnostics row for a probe save within 60 s"
    assert dv.saves and not any(profiles.S3_FIRE_MARKER in p["perf_text"] for _, p in dv.saves)
    assert clock.time() - START < 120                           # gave up after about --trace-settle


def test_s2_counts_one_row_per_save_and_changes_each_root_to_another_lookup():
    # P14: the engine plug-in runs twice for every measured save; each save counts once, the slower row kept.
    clock = FakeClock()
    dv = FakeDv(clock, roots=3, on_save=lambda root_id, payload: ['{"totalMs":300}', '{"totalMs":120}'])
    [result] = _ops(dv, clock).drive("S2", 100, 3)
    assert result["passed"], result["error"]
    assert result["summary"]["samples"] == 3 and result["summary"]["totalMs"] == 300
    assert result["duplicateDiagRows"] == 3
    current = {"root-0": "l1-0", "root-1": "l1-0", "root-2": "l1-0"}
    for root_id, payload in dv.saves:                           # the probe too: every save changes the lookup
        target = payload["perf_lookup1id@odata.bind"]
        assert target != f"/perf_lookup1s({current[root_id]})"
        current[root_id] = target[len("/perf_lookup1s("):-1]


def _s3_rows(kept):
    """on_save for S3: every probe writes a row; measured save n (1-based) writes what kept(n) returns."""
    measured = []

    def on_save(root_id, payload):
        if profiles.S3_FIRE_MARKER not in payload["perf_text"]:
            return ['{"totalMs":5}']
        measured.append(payload)
        return kept(len(measured))
    return on_save


def test_one_missing_row_fails_the_step_after_the_read_window():
    # The table replaces the lossy trace log: every measured save must have its row.
    clock = FakeClock()
    dv = FakeDv(clock, roots=5, on_save=_s3_rows(lambda n: [] if n == 4 else [f'{{"totalMs":{n}00}}']))
    [result] = _ops(dv, clock).drive("S3", 100, 5)
    assert result["error"] == "found 4 of 5 diagnostics rows" and result["diagCaptured"] == "4/5"
    assert result["summary"]["samples"] == 4
    assert 60 <= clock.time() - START < 90                      # sat out the 60-second read window, no more


def test_an_unparseable_row_counts_as_missing():
    clock = FakeClock()
    dv = FakeDv(clock, roots=3, on_save=_s3_rows(lambda n: ['{"totalMs":' if n == 2 else '{"totalMs":100}']))
    [result] = _ops(dv, clock).drive("S3", 100, 3)
    assert result["error"] == "found 2 of 3 diagnostics rows" and result["diagCaptured"] == "2/3"


def test_reading_the_rows_back_stops_as_soon_as_every_save_has_one():
    clock = FakeClock()
    dv = FakeDv(clock, roots=5, on_save=_s3_rows(lambda n: ['{"totalMs":100}']))
    [result] = _ops(dv, clock).drive("S3", 100, 5)
    assert result["passed"] and result["diagCaptured"] == "5/5"
    assert clock.time() - START < 30                            # not the 60-second read window


def test_save_scenarios_sample_ten_roots_by_default():
    assert [rs.default_sample(s) for s in rs.SCENARIOS] == [5, 10, 10, 5, 5, 5]


def test_the_enforcement_probe_waits_up_to_ten_minutes_by_default():
    assert rs.parse_args(["--scenario", "S2"]).settle_seconds == 600


def test_a_failed_measured_save_waits_only_for_the_saves_that_succeeded():
    clock = FakeClock()

    def on_save(root_id, payload):
        if payload["perf_text"] == "S3FIRE-1":
            raise FakeDv.DataverseError("PATCH", f"perf_roots({root_id})", 500, "plug-in timed out")
        return ['{"totalMs":100}']

    dv = FakeDv(clock, roots=3, on_save=on_save)
    [result] = _ops(dv, clock).drive("S3", 100, 3)
    assert result["error"].startswith("save 2: PATCH perf_roots(root-1)")
    assert result["summary"]["samples"] == 1 and result["diagCaptured"] == "1/2"
    assert clock.time() - START < 30                            # no 60-second poll for a row that can't come


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
