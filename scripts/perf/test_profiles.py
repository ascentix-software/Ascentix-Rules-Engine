"""Unit tests for profiles.py (pure; no Dataverse). Run: python scripts/perf/test_profiles.py"""
import datetime
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import profiles  # noqa: E402


def test_flat_children_split_categories_in_exact_thirds():
    rows = [profiles.flat_child_payload(i, i, "root-1", "l1-1", "2026-09-01T00:00:00Z", "perf_RootId", "perf_Child1LookupId")
            for i in range(300)]
    cats = [r["perf_category"] for r in rows]
    assert cats.count(30001) == cats.count(30002) == cats.count(30003) == 100
    assert rows[5]["perf_name"] == "PERF-C1-000005"
    assert rows[0]["perf_RootId@odata.bind"] == "/perf_roots(root-1)"
    assert rows[0]["perf_Child1LookupId@odata.bind"] == "/perf_lookup1s(l1-1)"
    assert rows[0]["perf_date"] == "2026-09-01T00:00:00Z"
    assert all(r["perf_name"].startswith("PERF") for r in rows)


def test_date_values_are_deterministic_utc_midnights_within_sixty_days():
    today = datetime.date(2026, 9, 30)
    rng = random.Random(7)
    first = [profiles.date_value(rng, today) for _ in range(20)]
    rng = random.Random(7)
    second = [profiles.date_value(rng, today) for _ in range(20)]
    assert first == second
    for value in first:
        assert value.endswith("T00:00:00Z")
        day = datetime.date.fromisoformat(value[:10])
        assert today - datetime.timedelta(days=60) <= day <= today


def test_a_block_downgrades_to_a_show_message_with_the_same_text():
    block = {"asx_name": "act-1234abcd-block", "asx_actiontype": 4, "asx_fireon": 2, "asx_message": "m", "asx_severity": 3}
    shown = profiles.downgrade_block(block)
    assert shown["asx_actiontype"] == 3
    assert shown["asx_name"] == "act-1234abcd-msg"
    assert (shown["asx_fireon"], shown["asx_message"], shown["asx_severity"]) == (2, "m", 3)
    other = {"asx_name": "act-x-msg", "asx_actiontype": 3}
    assert profiles.downgrade_block(other) == other


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("OK")
