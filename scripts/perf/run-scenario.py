"""Performance scenario driver (dev-only; DEV environment only).

Runs one scenario up its ladder, stopping at the first failing step, and writes
docs/perf/reports/<date>-<label>-<scenario>.md / .csv / .json and the combined
<date>-<label>-capacity.md (git-ignored).

    python scripts/perf/run-scenario.py --scenario S1 [--ladder 100,500,2000] [--label baseline]
                                        [--sample N] [--trace-settle 180]

Each step: reset the data (reset-data.py), generate the step's data and rules (generate.py), drive
the scenario, record pass or fail with its error, per-stage timings and counters. At the end, even
on an error or Ctrl+C, the data is reset and (S2, S3) the environment's original plug-in trace
setting is restored. Refuses to run unless the target is the DEV environment in .env. Never prints
secrets. Never switches the scheduler add-on's flow on or off: S5 refuses to start while it runs.
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
TRACE_ALL = 2                  # organization.plugintracelogsetting: 0 Off, 1 Exception, 2 All
ROW_CAP = 50000                # child rows generated per S1-S3 step at most
SYNC_TARGET_MS = 2000          # S1, S6
SCHEDULER_BUDGET_MS = 60000    # S5
SCHEDULER_WINDOW_MINUTES = 20  # another caller's heartbeat younger than this blocks S5
SCHEDULER_FLOW = "Rules Engine Scheduler"
PROBE_POLL_SECONDS = 15        # how long one probe save's asx-diag line is looked for before probing again
TRACE_POLL_INTERVAL = 5
DIAG_PREFIX = "asx-diag "
RECORD_FAILED = re.compile(r"asx_ProcessRunPage:record-failed:([0-9a-fA-F-]{36}):([^\r\n]*)")
S4_VARIANTS = (("no-writes", "PERF-RULE-S4-READ"), ("set-update", "PERF-RULE-S4-WRITE"))
ENGINE_PLUGIN = "Ascentix.RulesEngine.Plugin.RulesEnginePlugin"
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
    """Roots sampled per step: 10 for the save scenarios, whose figures come only from the saves whose
    trace line Dataverse kept (see enough_captured); 5 for the others."""
    return 10 if scenario in SAVE_SCENARIOS else 5


def enough_captured(captured, saves):
    """Dataverse doesn't keep every plug-in trace row, even with tracing on All, so a missing asx-diag
    line is not a failure: a save step needs a line for at least half its saves."""
    return captured >= (saves + 1) // 2


def roots_for_step(scenario, step, sample):
    if scenario in ("S1", "S2", "S3"):
        return max(1, min(sample, ROW_CAP // step))
    if scenario == "S4":
        return step
    return sample


def generate_args(scenario, step, sample):
    if scenario in ("S1", "S2", "S3"):
        return ["--records", str(roots_for_step(scenario, step, sample)), "--rows-per-root", str(step), "--profile", scenario]
    if scenario == "S4":
        return ["--records", str(step), "--rows-per-root", "1", "--profile", "S4"]
    if scenario == "S5":
        return ["--records", str(sample), "--rows-per-root", "1", "--profile", "S5", "--profile-step", str(step)]
    return ["--records", str(sample), "--child-fanout", "3", "--profile", "S6", "--profile-step", str(step)]


def bound_error(scenario, summary, expected=None):
    """The scenario-specific failure bound (spec §2); None when the step is within it."""
    if scenario in ("S1", "S6") and summary["totalMs"] > SYNC_TARGET_MS:
        return f"median totalMs {summary['totalMs']} > {SYNC_TARGET_MS}"
    if scenario == "S5":
        if summary["totalMs"] > SCHEDULER_BUDGET_MS:
            return f"totalMs {summary['totalMs']} > {SCHEDULER_BUDGET_MS}"
        handled = summary["counters"].get("schedulesStarted", 0) + summary["counters"].get("schedulesContinued", 0)
        if expected is not None and handled < expected:
            return f"{handled} of {expected} due schedules started or continued"
    return None


def parse_diag_lines(messageblock):
    """Every asx-diag line of a plug-in trace messageblock. A line that doesn't parse as a JSON object
    (cut off by the trace log's size limit, say) is skipped, so it counts as missing."""
    found = []
    for line in (messageblock or "").splitlines():
        at = line.find(DIAG_PREFIX)
        if at < 0:
            continue
        try:
            diag = json.loads(line[at + len(DIAG_PREFIX):].strip())
        except ValueError:
            continue
        if isinstance(diag, dict):
            found.append(diag)
    return found


def save_key(row):
    """The save a plugintracelogs row belongs to. The log carries no record id, but every measured
    PATCH is its own top-level request, so its correlation id identifies the save: a second engine
    execution for the same save (another message or stage, or a nested write) shares it."""
    return row.get("correlationid") or row.get("requestid") or row.get("plugintracelogid")


def diag_lines_per_save(rows, exclude=()):
    """One asx-diag line per save, in first-seen order, skipping saves in exclude. When the engine
    plug-in ran more than once for a save, the line with the larger totalMs is kept.
    Returns (lines, number of extra lines dropped)."""
    best = {}
    duplicates = 0
    for row in rows:
        key = save_key(row)
        if key in exclude:
            continue
        for diag in parse_diag_lines(row.get("messageblock")):
            if key not in best:
                best[key] = diag
                continue
            duplicates += 1
            if diag.get("totalMs", 0) > best[key].get("totalMs", 0):
                best[key] = diag
    return list(best.values()), duplicates


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


def run_ladder(ops, scenario, ladder, sample, log=print, results=None):
    """Runs the ladder, appending to results as it goes (so a caller keeps the finished steps even if
    this raises) and stopping at the first failing step. A failing reset or generate is a setup failure."""
    results = [] if results is None else results
    for step in ladder:
        try:
            log(f"{scenario} step {step}: reset")
            ops.reset()
            log(f"{scenario} step {step}: generate")
            ops.prepare(scenario, step, sample)
        except Exception as e:  # noqa: BLE001
            results.append(aggregate.step_result(scenario, step, None, f"setup: {e}"))
            break
        log(f"{scenario} step {step}: drive")
        try:
            step_results = ops.drive(scenario, step, sample)
        except Exception as e:  # noqa: BLE001
            step_results = [aggregate.step_result(scenario, step, None, str(e))]
        results.extend(step_results)
        for r in step_results:
            log(f"  {r['step']}: {'pass' if r['passed'] else 'FAIL ' + str(r['error'])} ({r['summary']['totalMs']} ms)")
        if any(not r["passed"] for r in step_results):
            break
    return results


def run(ops, scenario, ladder, sample, log=print, results=None):
    """run_ladder, then reset the data and restore the trace setting, whatever happened. A failing
    final reset is logged, not raised, so it never costs the results."""
    results = [] if results is None else results
    original = None
    try:
        if scenario in SAVE_SCENARIOS:
            original = ops.get_trace_setting()
            ops.set_trace_setting(TRACE_ALL)
        return run_ladder(ops, scenario, ladder, sample, log, results)
    finally:
        try:
            log(f"{scenario}: final reset")
            ops.reset()
        except Exception as e:  # noqa: BLE001
            log(f"{scenario}: final reset failed, run reset-data.py by hand: {e}")
        finally:
            if original is not None:
                ops.set_trace_setting(original)
                log(f"{scenario}: plug-in trace setting restored")


def run_and_report(ops, scenario, ladder, sample, reports_dir, label, today=datetime.date.today, log=print):
    """run, then write the reports from whatever steps finished, even when run raised (Ctrl+C, a
    failed trace restore). The date is taken at the start, so a ladder that crosses midnight is
    reported, and joins the capacity summary, under its start date. Returns (results, report paths)."""
    date_str = today().isoformat()
    results = []
    try:
        run(ops, scenario, ladder, sample, log, results)
    finally:
        paths = write_reports(reports_dir, date_str, label, scenario, results) if results else []
        if paths:
            log("Reports: " + ", ".join(paths))
    return results, paths


def write_reports(reports_dir, date_str, label, scenario, results):
    os.makedirs(reports_dir, exist_ok=True)
    prefix = f"{date_str}-{label}-"
    base = os.path.join(reports_dir, prefix + scenario)
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

    def __init__(self, repo_root, trace_settle_seconds, log=print, dv=None, clock=time.time, sleep=time.sleep):
        if dv is None:
            import _dv as dv  # reads .env through scripts/auth.py and fetches a token; never prints either
        self._dv = dv
        self.repo_root = repo_root
        self.trace_settle_seconds = trace_settle_seconds
        self.log = log
        self._clock = clock
        self._sleep = sleep
        self._org_id = None
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

    def prepare(self, scenario, step, sample):
        self._script("generate.py", generate_args(scenario, step, sample))

    def get_trace_setting(self):
        org = self._get("organizations?$select=organizationid,plugintracelogsetting")["value"][0]
        self._org_id = org["organizationid"]
        return org["plugintracelogsetting"]

    def set_trace_setting(self, value):
        # No fixed settle wait: each save step's probe save waits for tracing and enforcement to be live.
        self._call("PATCH", f"organizations({self._org_id})", {"plugintracelogsetting": value})

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
        return [aggregate.step_result(scenario, step, summary, bound_error(scenario, summary))]

    # -- S2, S3: real saves, diagnostics read back from plugintracelogs ------

    def _drive_saves(self, scenario, step, sample):
        roots = self._roots(roots_for_step(scenario, step, sample), ",_perf_lookup1id_value")
        if not roots:
            return [aggregate.step_result(scenario, step, None, "no perf_root rows to save")]
        pool, nav_l1 = [], None
        if scenario == "S2":
            pool = [r["perf_lookup1id"] for r in self._get("perf_lookup1s?$select=perf_lookup1id&$top=20")["value"]]
            nav_l1 = self._dv.resolve_nav_property("perf_root", "perf_lookup1", "perf_lookup1id")
        try:
            settled = self._await_enforcement(scenario, roots[0], pool, nav_l1)
        except self._dv.DataverseError as e:
            return [aggregate.step_result(scenario, step, None, f"probe save: {e}")]
        if settled is None:
            return [aggregate.step_result(scenario, step, None,
                                          f"enforcement did not settle: no asx-diag line for a probe save within "
                                          f"{self.trace_settle_seconds} s")]
        since, probe_saves = settled
        saves, error = 0, None
        for i, root in enumerate(roots):
            saves += 1
            try:
                self._call("PATCH", f"perf_roots({root['perf_rootid']})",
                           self._save_payload(scenario, root, i, pool, nav_l1), timeout=150)
            except self._dv.DataverseError as e:
                error = f"save {saves}: {e}"
                break
        # After a failed save, wait only for the lines of the saves that succeeded (the failed one may
        # leave no line): polling for all of them would just sit out the timeout.
        succeeded = saves if error is None else saves - 1
        lines, duplicates = self._read_diag_lines(since, succeeded, probe_saves)
        if error is None and not enough_captured(len(lines), saves):
            error = f"found {len(lines)} of {saves} asx-diag lines in plugintracelogs"
        result = aggregate.step_result(scenario, step, aggregate.summarize_saves(lines), error)
        result["diagCaptured"] = f"{len(lines)}/{saves}"
        if duplicates:
            result["duplicateDiagLines"] = duplicates
            self.log(f"  {duplicates} extra asx-diag line(s): the engine ran more than once for a save; "
                     "kept the slower line per save")
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

    def _await_enforcement(self, scenario, root, pool, nav_l1):
        """Probe saves of one sampled root until one's asx-diag line shows up, so tracing and the step's
        freshly published enforcement are live before measuring (retrying for up to --trace-settle).
        S2 probes with a lookup change, like its measured saves; S3 with a perf_text without the fire
        marker, so the probe runs the engine but leaves the root's rows untouched.
        Returns (since, probe save keys) for reading the measured lines back, or None."""
        before = self._latest_trace_time()
        deadline = self._clock() + self.trace_settle_seconds
        attempt = 0
        while attempt == 0 or self._clock() < deadline:
            attempt += 1
            payload = (self._save_payload("S2", root, attempt, pool, nav_l1) if scenario == "S2"
                       else {"perf_text": f"PERF-PROBE-{attempt}"})
            self.log(f"  probe save {attempt}")
            self._call("PATCH", f"perf_roots({root['perf_rootid']})", payload, timeout=150)
            look_until = min(deadline, self._clock() + PROBE_POLL_SECONDS)
            while True:
                rows = self._engine_trace_rows("gt", before)
                if diag_lines_per_save(rows)[0]:
                    return max(r["createdon"] for r in rows), {save_key(r) for r in rows}
                if self._clock() >= look_until:
                    break
                self._sleep(TRACE_POLL_INTERVAL)
        return None

    def _latest_trace_time(self):
        rows = self._get("plugintracelogs?$select=createdon&$orderby=createdon%20desc&$top=1")["value"]
        return rows[0]["createdon"] if rows else "2000-01-01T00:00:00Z"

    def _engine_trace_rows(self, op, since):
        """The engine plug-in's trace rows for perf_root updates created after (gt) or from (ge) since.
        Update and UpdateMultiple: a single save can reach the engine through either message."""
        flt = urllib.parse.quote(f"startswith(typename,'{ENGINE_PLUGIN}') and primaryentity eq 'perf_root' "
                                 f"and (messagename eq 'Update' or messagename eq 'UpdateMultiple') "
                                 f"and createdon {op} {since}")
        return self._get("plugintracelogs?$select=plugintracelogid,correlationid,requestid,messageblock,createdon"
                         f"&$filter={flt}&$orderby=createdon%20asc")["value"]

    def _read_diag_lines(self, since, expected, exclude, timeout_s=180):
        """The measured saves' lines: rows from the probe's createdon on (createdon has whole-second
        precision, so a save in the probe's second is not lost), less the probe's own saves. Stops as soon
        as every expected save has a line, or when the window ends with whatever was captured: Dataverse
        drops some trace rows, so the caller judges the count (enough_captured)."""
        deadline = self._clock() + timeout_s
        while True:
            lines, duplicates = diag_lines_per_save(self._engine_trace_rows("ge", since), exclude)
            if len(lines) >= expected or self._clock() > deadline:
                return lines, duplicates
            self._sleep(TRACE_POLL_INTERVAL)

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
        return [aggregate.step_result("S5", step, summary, bound_error("S5", summary, expected=step))]

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


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run one performance scenario up its ladder on DEV.")
    parser.add_argument("--scenario", required=True, choices=SCENARIOS)
    parser.add_argument("--ladder", help="comma list of step sizes (default: the scenario's ladder from the spec)")
    parser.add_argument("--label", default="baseline", help="report label (default: baseline)")
    parser.add_argument("--sample", type=int, default=None, help="roots sampled per step (default: 10 for S2 "
                                                                   "and S3, 5 for the others)")
    parser.add_argument("--trace-settle", type=int, default=180,
                        help="S2/S3: seconds to keep probing for a probe save's asx-diag line before a step's "
                             "measured saves (default: 180)")
    args = parser.parse_args(argv)
    ladder = parse_ladder(args.ladder) if args.ladder else DEFAULT_LADDERS[args.scenario]

    env_url = read_env_file_url(ENV_FILE)
    check_dev_target(os.environ.get("DATAVERSE_URL") or env_url, env_url)
    print(f"DEV target confirmed. {args.scenario} ladder: {', '.join(str(s) for s in ladder)}")

    ops = DataverseOps(REPO_ROOT, args.trace_settle)
    if args.scenario == "S5":
        try:
            ops.check_scheduler_idle()
        except RuntimeError as e:
            raise SystemExit(f"Refusing to run S5: {e}")
    sample = args.sample or default_sample(args.scenario)
    run_and_report(ops, args.scenario, ladder, sample, REPORTS_DIR, args.label)


if __name__ == "__main__":
    main()
