"""Scenario profiles for the perf harness (docs/superpowers/specs/2026-09-29-performance-baseline-design.md).

Pure: no Dataverse access, so test_profiles.py covers it without an environment. generate.py does
the posting. This module holds the flat per-root child rows, their dates, the Block downgrade used
for save-driven profiles, and (Task 6) each profile's rule shapes and payload builders. It is also
the single home for the harness constants shared across profiles.py and generate.py (CATEGORY_OPTIONS,
ACT_SHOWMSG, ACT_BLOCK) — generate.py imports this module rather than redefining them.
"""
import datetime
import json

CATEGORY_OPTIONS = [30001, 30002, 30003]   # perf_category, create-schema.py add_typed_columns

ACT_SHOWMSG = 3
ACT_BLOCK = 4


def _json(value):
    return json.dumps(value, separators=(",", ":"))


def date_value(date_rng, today):
    """A perf_date value (DateOnly, User Local: an Edm.DateTimeOffset at UTC midnight), 0-60 days
    before today. Drawn from its own random stream so the other generated values keep their
    existing sequence."""
    day = today - datetime.timedelta(days=date_rng.randint(0, 60))
    return day.isoformat() + "T00:00:00Z"


def flat_child_payload(index, j, root_id, l1_id, date_val, nav_root, nav_l1):
    """The j-th perf_child1 row of a root in --rows-per-root mode. Values are position-based, not
    random, so a step's partitions are exact: perf_category cycles 30001/30002/30003 (S3 splits its
    set actions on it). date_val (not date_value, to avoid shadowing the module function above) is
    the already-computed perf_date string for this row."""
    return {
        "perf_name":     f"PERF-C1-{index:06d}",
        "perf_text":     f"c1text{j}",
        "perf_number":   j % 500,
        "perf_amount":   float(j % 2000),
        "perf_flag":     j % 2 == 0,
        "perf_category": CATEGORY_OPTIONS[j % 3],
        "perf_date":     date_val,
        f"{nav_root}@odata.bind": f"/perf_roots({root_id})",
        f"{nav_l1}@odata.bind":   f"/perf_lookup1s({l1_id})",
    }


def downgrade_block(action):
    """A background Block action as a Show Message with the same trigger, text and severity: the same
    condition and traversal cost, but it can never fail the save a save-driven profile measures."""
    if action.get("asx_actiontype") != ACT_BLOCK:
        return action
    return {**action, "asx_actiontype": ACT_SHOWMSG, "asx_name": action["asx_name"].replace("-block", "-msg")}
