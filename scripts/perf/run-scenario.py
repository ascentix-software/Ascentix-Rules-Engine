"""Performance scenario driver (dev-only; DEV environment only).

Runs one scenario up its ladder, stopping at the first failing step, and writes
docs/perf/reports/<date>-<label>-<scenario>.md / .csv / .json and the combined
<date>-<label>-capacity.md (git-ignored).

    python scripts/perf/run-scenario.py --scenario S1 [--ladder 100,500,2000] [--label baseline]
                                        [--sample N] [--rules N] [--trace-settle 600] [--settle-probes 5]
                                        [--settle-pause 120] [--retry-pause 60]

Each step: reset the data (reset-data.py), generate the step's data and rules (generate.py), drive
the scenario, record pass or fail with its error, per-stage timings and counters. S2 and S3 read each
save's diagnostics from its asx_rulediagnostic row, so they switch the asx_CaptureDiagnostics
environment variable on for the run. At the end, even on an error or Ctrl+C, the data is reset and
(S2, S3) the switch is put back exactly as it was. Refuses to run unless the target is the DEV
environment in .env. Never prints secrets. Never switches the scheduler add-on's flow on or off: S5
refuses to start while it runs.
"""
import argparse
import csv
import datetime
import glob
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import aggregate  # noqa: E402  (pure: no Dataverse)
import profiles  # noqa: E402  (pure: no Dataverse)
from profiles import SAVE_PROFILES as SAVE_SCENARIOS, S3_FIRE_MARKER  # noqa: E402

SCENARIOS = profiles.PROFILES
DEFAULT_LADDERS = {
    "S1": [100, 500, 2000, 5000, 10000],
    "S2": [100, 500, 2000, 5000, 10000],
    "S3": [100, 500, 2000, 5000, 10000],
    "S4": [1000, 10000, 50000],
    "S5": [1, 10, 50],
    "S6": [1, 2, 3, 4, 5, 6, 7],
}
ROW_CAP = 50000                # child rows generated per S1-S3 step at most
SYNC_TARGET_MS = 2000          # S1, S6
SCHEDULER_BUDGET_MS = 60000    # S5
SCHEDULER_WINDOW_MINUTES = 20  # another caller's heartbeat younger than this blocks S5
SCHEDULER_FLOW = "Rules Engine Scheduler"
CAPTURE_SWITCH = "asx_CaptureDiagnostics"  # Boolean environment variable: saves write asx_rulediagnostic rows
CAPTURE_ON = "yes"             # Dataverse stores a Boolean environment variable's value as yes/no
DEFAULT_SETTLE_SECONDS = 600   # the whole enforcement wait, pauses included: then the step fails
DEFAULT_SETTLE_PAUSE = 120     # wait after publishing before the first probe save
DEFAULT_RETRY_PAUSE = 60       # wait after a missed probe row before the next attempt
DEFAULT_SETTLE_PROBES = 5      # probe saves in a row that must each write their row before measuring (R16)
PROBE_POLL_SECONDS = 15        # how long one probe save's diagnostics row is looked for before it counts as missed
DIAG_READ_SECONDS = 60         # how long the measured saves' rows are looked for after the last save
DIAG_POLL_INTERVAL = 5
RECORD_FAILED = re.compile(r"asx_ProcessRunPage:record-failed:([0-9a-fA-F-]{36}):([^\r\n]*)")
S4_VARIANTS = (("no-writes", "PERF-RULE-S4-READ"), ("set-update", "PERF-RULE-S4-WRITE"))
REPO_ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
REPORTS_DIR = os.path.join(REPO_ROOT, "docs", "perf", "reports")
ENV_FILE = os.path.join(REPO_ROOT, ".env")


# ---------------------------------------------------------------------------
# Pure step logic (test_run_scenario.py)
# ---------------------------------------------------------------------------

def parse_ladder(text):
    return [int(part.strip()) for part in text.split(",") if part.strip()]


def read_env_file_url(path):
    """DATAVERSE_URL from the .env file itself, parsed like scripts/auth.py. Never printed."""
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                if key.strip() == "DATAVERSE_URL":
                    return value.strip()
    return None


def _norm(url):
    return (url or "").strip().rstrip("/").lower()


def check_dev_target(effective_url, env_file_url):
    """The harness talks to whatever DATAVERSE_URL resolves to (the process environment wins over
    .env). Refuse unless that is the DEV environment named in .env."""
    if not env_file_url:
        raise SystemExit("Refusing to run: .env names no DATAVERSE_URL (the DEV environment).")
    if _norm(effective_url) != _norm(env_file_url):
        raise SystemExit("Refusing to run: DATAVERSE_URL in the process environment is not the DEV environment in .env.")


def default_sample(scenario):
    """Roots sampled per step: 10 for the save scenarios (one save each, so each step's median rests on
    10 saves); 5 for the others."""
    return 10 if scenario in SAVE_SCENARIOS else 5


def roots_for_step(scenario, step, sample):
    if scenario in ("S1", "S2", "S3"):
        return max(1, min(sample, ROW_CAP // step))
    if scenario == "S4":
        return step
    return sample


def generate_args(scenario, step, sample, rules=None):
    """generate.py's arguments for one step; --rules (the background rule count) only when given, so
    generate.py otherwise uses the profile's default."""
    return _generate_args(scenario, step, sample) + ([] if rules is None else ["--rules", str(rules)])


def _generate_args(scenario, step, sample):
    if scenario in ("S1", "S2", "S3"):
        return ["--records", str(roots_for_step(scenario, step, sample)), "--rows-per-root", str(step), "--profile", scenario]
    if scenario == "S4":
        return ["--records", str(step), "--rows-per-root", "1", "--profile", "S4"]
    if scenario == "S5":
        return ["--records", str(sample), "--rows-per-root", "1", "--profile", "S5", "--profile-step", str(step)]
    return ["--records", str(sample), "--child-fanout", "3", "--profile", "S6", "--profile-step", str(step)]


def background_rules(scenario, rules):
    """The background rule count a step runs with: --rules, or the profile's default generate.py uses."""
    return profiles.DEFAULT_BACKGROUND[scenario] if rules is None else rules


def bound_error(scenario, summary, expected=None):
    """A step's functional failure beyond an engine error: S5 must start or continue every due schedule.
    None when it did. Running slower than a time target is not a failure (see target_note)."""
    if scenario == "S5":
        handled = summary["counters"].get("schedulesStarted", 0) + summary["counters"].get("schedulesContinued", 0)
        if expected is not None and handled < expected:
            return f"{handled} of {expected} due schedules started or continued"
    return None


def target_note(scenario, summary):
    """A note when a step ran slower than its scenario's time target (S1/S6: median 2,000 ms; S5: 60,000 ms).
    Over target is data to report, not a failure: the step passes and the ladder goes on. None within target."""
    if scenario in ("S1", "S6") and summary["totalMs"] > SYNC_TARGET_MS:
        return f"over target: median totalMs {summary['totalMs']} > {SYNC_TARGET_MS}"
    if scenario == "S5" and summary["totalMs"] > SCHEDULER_BUDGET_MS:
        return f"over target: totalMs {summary['totalMs']} > {SCHEDULER_BUDGET_MS}"
    return None


def parse_diagnostics(text):
    """An asx_rulediagnostic row's diagnostics JSON as a dict, or None when it doesn't parse as a JSON
    object (so the row counts as missing)."""
    try:
        diag = json.loads(text or "")
    except ValueError:
        return None
    return diag if isinstance(diag, dict) else None


def diagnostics_per_save(rows, exclude=()):
    """One diagnostics object per saved record id (lower-cased), skipping row ids in exclude and rows
    that don't parse. Each sampled root is saved once while measuring, so a record id is a save; when
    the engine plug-in ran more than once for it, the row with the larger totalMs is kept.
    Returns ({record id: diagnostics}, number of extra rows dropped)."""
    best = {}
    duplicates = 0
    for row in rows:
        if row.get("asx_rulediagnosticid") in exclude:
            continue
        diag = parse_diagnostics(row.get("asx_diagnostics"))
        if diag is None:
            continue
        key = (row.get("asx_recordid") or "").lower()
        if key not in best:
            best[key] = diag
            continue
        duplicates += 1
        if diag.get("totalMs", 0) > best[key].get("totalMs", 0):
            best[key] = diag
    return best, duplicates


def record_failed(text):
    m = RECORD_FAILED.search(text or "")
    return (m.group(1), m.group(2).strip()) if m else None


def drive_run(call, run_id, max_pages):
    """Calls asx_ProcessRunPage until Done, as the scheduler flow does: a record-failed error is
    reported on the next call; a repeated one, any other error, or too many calls ends the run.
    The report call processes no records, so its diagnostics are not a page sample (only its Done counts).
    call(payload) returns the response body or raises. Returns (per-page diagnostics, error or None)."""
    pages = []
    failed = None
    calls = 0
    while calls < max_pages:
        payload = {"RunId": run_id, "IncludeDiagnostics": True}
        if failed:
            payload["FailedRecordId"], payload["FailedMessage"] = failed
            failed = None
        calls += 1
        try:
            body = call(payload)
        except Exception as e:  # noqa: BLE001 - every failure is recorded on the step
            marker = record_failed(str(e))
            if marker is None or "FailedRecordId" in payload:
                return pages, str(e)
            failed = marker
            continue
        if "FailedRecordId" not in payload:
            pages.append(json.loads(body["Diagnostics"]))
        if body.get("Done"):
            return pages, None
    return pages, f"run {run_id} did not finish within {max_pages} pages"


def _parse_time(text):
    return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))


def scheduler_busy(last_seen_on, last_seen_by, me, now, window_minutes=SCHEDULER_WINDOW_MINUTES):
    """True when another caller (the scheduler add-on's flow) called asx_StartDueSchedules recently:
    it would start the S5 schedules before the driver does."""
    if not last_seen_on or (last_seen_by or "").lower() == (me or "").lower():
        return False
    return now - _parse_time(last_seen_on) < datetime.timedelta(minutes=window_minutes)


def run_ladder(ops, scenario, ladder, sample, log=print, results=None, rules=None):
    """Runs the ladder, appending to results as it goes (so a caller keeps the finished steps even if
    this raises) and stopping at the first failing step (an error, never a time target: see target_note). A failing reset or generate is a setup failure.
    Every result records its background rule count (backgroundRules)."""
    results = [] if results is None else results
    count = background_rules(scenario, rules)
    for step in ladder:
        try:
            log(f"{scenario} step {step}: reset")
            ops.reset()
            log(f"{scenario} step {step}: generate")
            ops.prepare(scenario, step, sample, rules)
        except Exception as e:  # noqa: BLE001
            results.append({**aggregate.step_result(scenario, step, None, f"setup: {e}"), "backgroundRules": count})
            break
        log(f"{scenario} step {step}: drive")
        try:
            step_results = ops.drive(scenario, step, sample)
        except Exception as e:  # noqa: BLE001
            step_results = [aggregate.step_result(scenario, step, None, str(e))]
        for r in step_results:
            r["backgroundRules"] = count
        results.extend(step_results)
        for r in step_results:
            note = f"; {r['note']}" if r.get("note") else ""
            log(f"  {r['step']}: {'pass' if r['passed'] else 'FAIL ' + str(r['error'])} ({r['summary']['totalMs']} ms{note})")
        if any(not r["passed"] for r in step_results):
            break
    return results


def run(ops, scenario, ladder, sample, log=print, results=None, rules=None):
    """run_ladder, then reset the data and (S2, S3) put the capture switch back, whatever happened. The
    switch's state is read before it is turned on, so it is restored even when turning it on fails
    halfway. A failing final reset is logged, not raised, so it never costs the results."""
    results = [] if results is None else results
    switch = None
    try:
        if scenario in SAVE_SCENARIOS:
            switch = ops.read_capture_switch()
            ops.switch_capture_on(switch)
            was = (f"value {switch['value']!r}" if switch["valueId"] else f"no value, default {switch['defaultValue']!r}")
            log(f"{scenario}: {CAPTURE_SWITCH} on (was {was}; restored at the end)")
        return run_ladder(ops, scenario, ladder, sample, log, results, rules)
    finally:
        try:
            log(f"{scenario}: final reset")
            ops.reset()
        except Exception as e:  # noqa: BLE001
            log(f"{scenario}: final reset failed, run reset-data.py by hand: {e}")
        finally:
            if switch is not None:
                try:
                    ops.restore_capture_switch(switch)
                except BaseException:
                    log(f"{scenario}: {CAPTURE_SWITCH} could not be restored; set it back by hand: "
                        + ("delete its value row" if switch["valueId"] is None
                           else f"set its value back to {switch['value']!r}"))
                    raise
                log(f"{scenario}: {CAPTURE_SWITCH} restored")


def run_and_report(ops, scenario, ladder, sample, reports_dir, label, today=datetime.date.today, log=print,
                   rules=None):
    """run, then write the reports from whatever steps finished, even when run raised (Ctrl+C, a
    failed switch restore). The date is taken at the start, so a ladder that crosses midnight is
    reported, and joins the capacity summary, under its start date. Returns (results, report paths)."""
    date_str = today().isoformat()
    results = []
    try:
        run(ops, scenario, ladder, sample, log, results, rules)
    finally:
        paths = write_reports(reports_dir, date_str, label, scenario, results) if results else []
        if paths:
            log("Reports: " + ", ".join(paths))
    return results, paths


def ladder_step(result):
    """The ladder step a result belongs to: S4 reports step 1000 as 1000:no-writes and 1000:set-update."""
    return str(result["step"]).split(":")[0]


def _ladder_order(step):
    return (0, int(step), "") if step.isdigit() else (1, 0, step)


def merge_results(earlier, later):
    """A scenario's results after a later run of the same date and label: each ladder step the later run
    reached replaces every earlier row of that step; the other earlier steps are kept. Ordered by ladder
    step (a stable sort, so S4's variants keep their order)."""
    rerun = {ladder_step(r) for r in later}
    merged = [r for r in earlier if ladder_step(r) not in rerun] + list(later)
    return sorted(merged, key=lambda r: _ladder_order(ladder_step(r)))


def write_reports(reports_dir, date_str, label, scenario, results):
    """Merges results into the scenario's JSON for this date and label (merge_results), then renders the
    md and csv from the merged rows and rebuilds the capacity summary from every scenario's JSON."""
    os.makedirs(reports_dir, exist_ok=True)
    prefix = f"{date_str}-{label}-"
    base = os.path.join(reports_dir, prefix + scenario)
    if os.path.exists(base + ".json"):
        with open(base + ".json", encoding="utf-8") as f:
            results = merge_results(json.load(f), results)
    with open(base + ".json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    with open(base + ".md", "w", encoding="utf-8") as f:
        f.write(aggregate.render_scenario_markdown(scenario, label, date_str, results) + "\n")
    header, rows = aggregate.step_rows(results)
    with open(base + ".csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)
    by_scenario = {}
    for path in glob.glob(os.path.join(reports_dir, prefix + "S*.json")):
        name = os.path.basename(path)[len(prefix):-len(".json")]
        if name in SCENARIOS:
            with open(path, encoding="utf-8") as f:
                by_scenario[name] = json.load(f)
    capacity = os.path.join(reports_dir, prefix + "capacity.md")
    with open(capacity, "w", encoding="utf-8") as f:
        f.write(aggregate.render_capacity_markdown(label, date_str, aggregate.capacity_summary(by_scenario)) + "\n")
    return [base + ".md", base + ".csv", capacity]


# ---------------------------------------------------------------------------
# Live side (DEV; controller-run)
# ---------------------------------------------------------------------------

class DataverseOps:
    """reset/generate through the harness scripts; every other call straight to DEV.
    dv, clock and sleep are injectable so the tests drive it with a fake client and a fake clock."""

    def __init__(self, repo_root, settle_seconds, log=print, dv=None, clock=time.time, sleep=time.sleep,
                 settle_probes=DEFAULT_SETTLE_PROBES, settle_pause=DEFAULT_SETTLE_PAUSE,
                 retry_pause=DEFAULT_RETRY_PAUSE):
        if dv is None:
            import _dv as dv  # reads .env through scripts/auth.py and fetches a token; never prints either
        self._dv = dv
        self.repo_root = repo_root
        self.settle_seconds = settle_seconds
        self.settle_probes = settle_probes
        self.settle_pause = settle_pause
        self.retry_pause = retry_pause
        self.log = log
        self._clock = clock
        self._sleep = sleep
        self._me = dv.whoami()["UserId"]

    def _now(self):
        return datetime.datetime.fromtimestamp(self._clock(), datetime.timezone.utc)

    def _call(self, method, path, payload=None, timeout=180):
        return self._dv.request(method, path, payload, timeout=timeout)

    def _get(self, path):
        return self._call("GET", path)[1]

    def _script(self, name, args):
        self.log(f"  python scripts/perf/{name} {' '.join(args)}")
        proc = subprocess.run([sys.executable, os.path.join(HERE, name), *args], cwd=self.repo_root,
                              capture_output=True, text=True)
        if proc.returncode != 0:
            tail = (proc.stdout + proc.stderr).strip().splitlines()[-15:]
            raise RuntimeError(f"{name} failed: " + " | ".join(tail))

    def reset(self):
        self._script("reset-data.py", [])

    def prepare(self, scenario, step, sample, rules=None):
        self._script("generate.py", generate_args(scenario, step, sample, rules))

    # -- S2, S3: the asx_CaptureDiagnostics switch ---------------------------------

    def read_capture_switch(self):
        """The switch's state to restore: its definition id and default, and its value row's id and value
        (both None when it has no value row). Refuses a missing definition, and an inactive or second value
        row (the plug-in reads only an active one, so turning the switch on there would be guesswork)."""
        flt = urllib.parse.quote(f"schemaname eq '{CAPTURE_SWITCH}'")
        definitions = self._get("environmentvariabledefinitions?$select=environmentvariabledefinitionid,defaultvalue"
                                f"&$filter={flt}")["value"]
        if not definitions:
            raise RuntimeError(f"{CAPTURE_SWITCH} is not defined on this environment: run "
                               "Configure-RuleAuthoring.ps1 -Phase Schema")
        definition = definitions[0]
        values = self._capture_values(definition["environmentvariabledefinitionid"])
        if len(values) > 1:
            raise RuntimeError(f"{CAPTURE_SWITCH} has {len(values)} value rows: keep one and run again")
        if values and values[0].get("statecode") != 0:
            raise RuntimeError(f"{CAPTURE_SWITCH} has an inactive value row: activate or delete it and run again")
        value = values[0] if values else None
        return {"definitionId": definition["environmentvariabledefinitionid"],
                "defaultValue": definition.get("defaultvalue"),
                "valueId": value["environmentvariablevalueid"] if value else None,
                "value": value.get("value") if value else None}

    def _capture_values(self, definition_id):
        flt = urllib.parse.quote(f"_environmentvariabledefinitionid_value eq {definition_id}")
        return self._get("environmentvariablevalues?$select=environmentvariablevalueid,value,statecode"
                         f"&$filter={flt}")["value"]

    def switch_capture_on(self, state):
        """Sets the switch's value to yes: PATCHes its value row, or creates one bound to the definition.
        The plug-in's 60-second cache means saves see it within a minute (the enforcement probe waits)."""
        if state["valueId"]:
            self._call("PATCH", f"environmentvariablevalues({state['valueId']})", {"value": CAPTURE_ON})
            return
        nav = self._dv.resolve_nav_property("environmentvariablevalue", "environmentvariabledefinition",
                                            "environmentvariabledefinitionid")
        self._call("POST", "environmentvariablevalues",
                   {"schemaname": CAPTURE_SWITCH, "value": CAPTURE_ON,
                    f"{nav}@odata.bind": f"/environmentvariabledefinitions({state['definitionId']})"})

    def restore_capture_switch(self, state):
        """Puts the switch back as read_capture_switch found it: PATCHes the value row back, or, when there
        was none, deletes whatever value row exists now (found afresh, so a create that timed out after
        Dataverse made the row is undone too)."""
        if state["valueId"]:
            self._call("PATCH", f"environmentvariablevalues({state['valueId']})", {"value": state["value"]})
            return
        for value in self._capture_values(state["definitionId"]):
            self._call("DELETE", f"environmentvariablevalues({value['environmentvariablevalueid']})")

    def drive(self, scenario, step, sample):
        if scenario in ("S1", "S6"):
            return self._drive_run_rules(scenario, step, sample)
        if scenario in SAVE_SCENARIOS:
            return self._drive_saves(scenario, step, sample)
        if scenario == "S4":
            return self._drive_runs(step)
        return self._drive_scheduler(step)

    def _roots(self, count, extra=""):
        return self._get(f"perf_roots?$select=perf_rootid{extra}&$top={count}")["value"]

    def _drive_run_rules(self, scenario, step, sample):
        samples = []
        for root in self._roots(roots_for_step(scenario, step, sample)):
            body = self._call("POST", "asx_RunRules", {"TableName": "perf_root", "RecordId": root["perf_rootid"],
                                                       "Triggers": "OnUpdate", "IncludeDiagnostics": True})[1]
            samples.append(json.loads(body["Diagnostics"]))
        summary = aggregate.summarize_saves(samples)
        return [aggregate.step_result(scenario, step, summary, bound_error(scenario, summary),
                                      note=target_note(scenario, summary))]

    # -- S2, S3: real saves, diagnostics read back from asx_rulediagnostic ----------

    def _drive_saves(self, scenario, step, sample):
        roots = self._roots(roots_for_step(scenario, step, sample), ",_perf_lookup1id_value")
        if not roots:
            return [aggregate.step_result(scenario, step, None, "no perf_root rows to save")]
        pool, nav_l1 = [], None
        if scenario == "S2":
            pool = [r["perf_lookup1id"] for r in self._get("perf_lookup1s?$select=perf_lookup1id&$top=20")["value"]]
            nav_l1 = self._dv.resolve_nav_property("perf_root", "perf_lookup1", "perf_lookup1id")
        probe = {"saves": 0, "best": 0}
        try:
            settled = self._await_enforcement(scenario, roots, pool, nav_l1, probe)
        except self._dv.DataverseError as e:
            return [{**aggregate.step_result(scenario, step, None, f"probe save {probe['saves']}: {e}"),
                     "probeSaves": probe["saves"]}]
        if settled is None:
            return [{**aggregate.step_result(
                scenario, step, None,
                f"enforcement did not settle: {probe['best']} of {self.settle_probes} consecutive probe saves captured "
                f"({probe['saves']} probe saves in {self.settle_seconds} s)"), "probeSaves": probe["saves"]}]
        since, seen = settled
        saves, error = 0, None
        for i, root in enumerate(roots):
            saves += 1
            try:
                self._call("PATCH", f"perf_roots({root['perf_rootid']})",
                           self._save_payload(scenario, root, i, pool, nav_l1), timeout=150)
            except self._dv.DataverseError as e:
                error = f"save {saves}: {e}"
                break
        # A failed save rolls its row back with it, so wait only for the rows of the saves that succeeded.
        succeeded = [r["perf_rootid"] for r in roots[:saves if error is None else saves - 1]]
        per_save, duplicates = self._read_diagnostics(succeeded, since, seen)
        if error is None and len(per_save) < saves:
            error = f"found {len(per_save)} of {saves} diagnostics rows"
        result = aggregate.step_result(scenario, step, aggregate.summarize_saves(list(per_save.values())), error)
        result["diagCaptured"] = f"{len(per_save)}/{saves}"
        result["probeSaves"] = probe["saves"]
        if duplicates:
            result["duplicateDiagRows"] = duplicates
            self.log(f"  {duplicates} extra diagnostics row(s): the engine ran more than once for a save; "
                     "kept the slower row per save")
        return [result]

    @staticmethod
    def _save_payload(scenario, root, i, pool, nav_l1):
        """S2 changes the root's lookup to another perf_lookup1; S3 writes the marker that fires the set actions."""
        if scenario == "S2":
            others = [l1 for l1 in pool if l1 != root.get("_perf_lookup1id_value")]
            if not others:
                raise RuntimeError("S2 needs at least two perf_lookup1 rows")
            target = others[i % len(others)]
            root["_perf_lookup1id_value"] = target
            return {f"{nav_l1}@odata.bind": f"/perf_lookup1s({target})"}
        return {"perf_text": f"{S3_FIRE_MARKER}-{i}"}

    def _await_enforcement(self, scenario, roots, pool, nav_l1, probe):
        """Wait --settle-pause, then probe saves of the first sampled root until --settle-probes of them in a
        row each write a new diagnostics row within PROBE_POLL_SECONDS, so the switch (read through the
        plug-in's 60-second cache) and the step's freshly published enforcement are live before measuring.
        One captured probe proves only the server that took it: a server that ran the table's saves while it
        had no engine step keeps skipping a newly created step until its Dataverse cache clears, and a save
        routed there never runs the engine (R16). A missed row ends the attempt: the streak starts over after
        --retry-pause. The whole wait, pauses included, is capped at --trace-settle.
        S2 probes with a lookup change, like its measured saves; S3 with a perf_text without the fire
        marker, so the probe runs the engine but leaves the root's rows untouched. "New" means a row id
        not seen before that probe: comparing ids, not times, keeps the local clock out of it.
        Counts into probe (saves made, best streak). Returns (the last probe row's createdon, every row id
        of the sampled roots by then), or None."""
        root, ids = roots[0], [r["perf_rootid"] for r in roots]
        known = {r["asx_rulediagnosticid"] for r in self._diagnostic_rows([root["perf_rootid"]])}
        deadline = self._clock() + self.settle_seconds
        self.log(f"  waiting {self.settle_pause} s for the published rules to go live")
        self._sleep(min(self.settle_pause, self.settle_seconds))
        streak = 0
        while probe["saves"] == 0 or self._clock() < deadline:
            probe["saves"] += 1
            attempt = probe["saves"]
            payload = (self._save_payload("S2", root, attempt, pool, nav_l1) if scenario == "S2"
                       else {"perf_text": f"PERF-PROBE-{attempt}"})
            self._call("PATCH", f"perf_roots({root['perf_rootid']})", payload, timeout=150)
            look_until = min(deadline, self._clock() + PROBE_POLL_SECONDS)
            while True:
                probe_rows = [r for r in self._diagnostic_rows([root["perf_rootid"]])
                              if r["asx_rulediagnosticid"] not in known]
                if probe_rows or self._clock() >= look_until:
                    break
                self._sleep(DIAG_POLL_INTERVAL)
            if not probe_rows:
                pause = max(0, min(self.retry_pause, deadline - self._clock()))
                self.log(f"  probe save {attempt}: no diagnostics row; the streak of {streak} starts over "
                         f"in {pause:.0f} s")
                streak = 0
                self._sleep(pause)
                continue
            known |= {r["asx_rulediagnosticid"] for r in probe_rows}
            streak += 1
            probe["best"] = max(probe["best"], streak)
            self.log(f"  probe save {attempt}: captured ({streak} of {self.settle_probes} in a row)")
            if streak >= self.settle_probes:
                seen = {r["asx_rulediagnosticid"] for r in self._diagnostic_rows(ids)}
                return max(r["createdon"] for r in probe_rows), seen
        return None

    def _diagnostic_rows(self, record_ids, since=None):
        """asx_rulediagnostic rows of saved perf_root records with these ids, created from (ge) since when
        given, oldest first."""
        if not record_ids:
            return []
        match = " or ".join(f"asx_recordid eq '{rid}'" for rid in record_ids)
        flt = f"asx_tablelogicalname eq 'perf_root' and ({match})" + (f" and createdon ge {since}" if since else "")
        return self._get("asx_rulediagnostics?$select=asx_rulediagnosticid,asx_recordid,asx_diagnostics,createdon"
                         f"&$filter={urllib.parse.quote(flt)}&$orderby=createdon%20asc")["value"]

    def _read_diagnostics(self, record_ids, since, seen):
        """The measured saves' rows: rows of these records from the probe row's createdon on (server time,
        whole seconds, so ge), less every row that existed before the measured saves. Stops as soon as every
        record has a row, or when the read window ends with whatever was found (the caller judges the count).
        Rows are written inside the save, so they are normally all there on the first read."""
        deadline = self._clock() + DIAG_READ_SECONDS
        while True:
            per_save, duplicates = diagnostics_per_save(self._diagnostic_rows(record_ids, since), seen)
            if len(per_save) >= len(record_ids) or self._clock() >= deadline:
                return per_save, duplicates
            self._sleep(DIAG_POLL_INTERVAL)

    # -- S4: Rule Runs paged by asx_ProcessRunPage ----------------------------

    def _rule_id(self, name):
        flt = urllib.parse.quote(f"asx_name eq '{name}'")
        rows = self._get(f"asx_rules?$select=asx_ruleid&$filter={flt}")["value"]
        if len(rows) != 1:
            raise RuntimeError(f"expected one rule named {name}, found {len(rows)}")
        return rows[0]["asx_ruleid"]

    def _drive_runs(self, step):
        results = []
        nav_rule = self._dv.resolve_nav_property("asx_rulerun", "asx_rule", "asx_rule")
        for variant, name in S4_VARIANTS:
            headers, _ = self._call("POST", "asx_ruleruns", {f"{nav_rule}@odata.bind": f"/asx_rules({self._rule_id(name)})"})
            run_id = headers.get("OData-EntityId", "").split("(")[-1].rstrip(")")
            pages, error = drive_run(lambda payload: self._call("POST", "asx_ProcessRunPage", payload, timeout=150)[1],
                                     run_id, step // 500 * 3 + 10)
            results.append(aggregate.step_result("S4", f"{step}:{variant}", aggregate.summarize_pages(pages), error))
            if error:
                break
        return results

    # -- S5: the scheduler ------------------------------------------------------

    def check_scheduler_idle(self):
        """Refuse S5 while another caller's scheduler heartbeat is fresh. The driver never switches the
        flow itself: only its owner can switch it back on."""
        rows = self._get("asx_schedulerstatuses?$select=asx_lastseenon,_asx_lastseenby_value&$top=1")["value"]
        if rows and scheduler_busy(rows[0].get("asx_lastseenon"), rows[0].get("_asx_lastseenby_value"), self._me,
                                   self._now()):
            raise RuntimeError(f"another caller called asx_StartDueSchedules in the last {SCHEDULER_WINDOW_MINUTES} "
                               f"minutes: turn the \"{SCHEDULER_FLOW}\" flow off for S5 (and back on afterwards), "
                               f"then wait {SCHEDULER_WINDOW_MINUTES} minutes")

    def _drive_scheduler(self, step):
        self.check_scheduler_idle()
        self._wait_until_due(step)
        body = self._call("POST", "asx_StartDueSchedules", {"IncludeDiagnostics": True}, timeout=150)[1]
        summary = aggregate.summarize_saves([json.loads(body["Diagnostics"])])
        return [aggregate.step_result("S5", step, summary, bound_error("S5", summary, expected=step),
                                      note=target_note("S5", summary))]

    def _wait_until_due(self, expected, cap_minutes=20):
        """Wait until every PERF schedule is due (a minute past the latest Next run on). A null Next run
        on is not yet due: keep reading until the cap."""
        flt = urllib.parse.quote("startswith(asx_name,'PERF-RULE') and asx_on eq true")
        deadline = self._clock() + cap_minutes * 60
        while True:
            rows = self._get(f"asx_ruleschedules?$select=asx_nextrunon&$filter={flt}")["value"]
            if len(rows) < expected:
                raise RuntimeError(f"expected {expected} PERF schedules, found {len(rows)}")
            pending = sum(1 for r in rows if not r.get("asx_nextrunon"))
            remaining = deadline - self._clock()
            if pending:
                if remaining <= 0:
                    raise RuntimeError(f"{pending} of {len(rows)} PERF schedules still have no Next run on "
                                       f"after {cap_minutes} minutes")
                wait = min(60, remaining)
                self.log(f"  {pending} schedule(s) have no Next run on yet; reading again in {int(wait)} s")
            else:
                latest = max(_parse_time(r["asx_nextrunon"]) for r in rows)
                due_in = (latest - self._now()).total_seconds() + 60
                if due_in <= 0:
                    return
                if due_in > remaining:
                    raise RuntimeError(f"schedules are due in {int(due_in)} s, beyond the {cap_minutes}-minute wait")
                wait = min(60, due_in)
                self.log(f"  waiting {int(due_in)} s for the schedules to come due")
            self._sleep(wait)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Run one performance scenario up its ladder on DEV.")
    parser.add_argument("--scenario", required=True, choices=SCENARIOS)
    parser.add_argument("--ladder", help="comma list of step sizes (default: the scenario's ladder from the spec)")
    parser.add_argument("--label", default="baseline", help="report label (default: baseline)")
    parser.add_argument("--sample", type=int, default=None, help="roots sampled per step (default: 10 for S2 "
                                                                   "and S3, 5 for the others)")
    parser.add_argument("--rules", type=int, default=None,
                        help="background rules per step, passed to generate.py (default: the profile's default: "
                             + ", ".join(f"{k} {v}" for k, v in profiles.DEFAULT_BACKGROUND.items())
                             + "); recorded in the reports")
    parser.add_argument("--trace-settle", dest="settle_seconds", metavar="SECONDS", type=int,
                        default=DEFAULT_SETTLE_SECONDS,
                        help="S2/S3: the enforcement-settle window, the whole wait (pauses included) for probe saves' "
                             f"diagnostics rows before a step's measured saves (default: {DEFAULT_SETTLE_SECONDS}; "
                             "the name is kept from when S2/S3 read the trace log)")
    parser.add_argument("--settle-pause", type=int, default=DEFAULT_SETTLE_PAUSE, metavar="SECONDS",
                        help="S2/S3: the wait after publishing before the first probe save "
                             f"(default: {DEFAULT_SETTLE_PAUSE})")
    parser.add_argument("--retry-pause", type=int, default=DEFAULT_RETRY_PAUSE, metavar="SECONDS",
                        help="S2/S3: the wait after a missed probe row before the next attempt "
                             f"(default: {DEFAULT_RETRY_PAUSE})")
    parser.add_argument("--settle-probes", type=int, default=DEFAULT_SETTLE_PROBES,
                        help="S2/S3: probe saves in a row that must each write their diagnostics row before a "
                             "step's measured saves; a miss starts the count over (default: "
                             f"{DEFAULT_SETTLE_PROBES})")
    args = parser.parse_args(argv)
    if args.settle_probes < 1:
        parser.error("--settle-probes must be at least 1")
    if args.settle_pause < 0 or args.retry_pause < 0:
        parser.error("--settle-pause and --retry-pause must not be negative")
    return args


def main(argv=None):
    args = parse_args(argv)
    ladder = parse_ladder(args.ladder) if args.ladder else DEFAULT_LADDERS[args.scenario]

    env_url = read_env_file_url(ENV_FILE)
    check_dev_target(os.environ.get("DATAVERSE_URL") or env_url, env_url)
    print(f"DEV target confirmed. {args.scenario} ladder: {', '.join(str(s) for s in ladder)}; background rules: "
          f"{background_rules(args.scenario, args.rules)}")

    ops = DataverseOps(REPO_ROOT, args.settle_seconds, settle_probes=args.settle_probes,
                       settle_pause=args.settle_pause, retry_pause=args.retry_pause)
    if args.scenario == "S5":
        try:
            ops.check_scheduler_idle()
        except RuntimeError as e:
            raise SystemExit(f"Refusing to run S5: {e}")
    sample = args.sample or default_sample(args.scenario)
    run_and_report(ops, args.scenario, ladder, sample, REPORTS_DIR, args.label, rules=args.rules)


if __name__ == "__main__":
    main()
