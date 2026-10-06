"""Offline test for author-rules.py ordering (no Dataverse: _dv is replaced by a recording fake).
Run from the repo root: python scripts/sample-app/test_author_rules.py"""
import contextlib
import importlib.util
import io
import os
import sys
import types
import urllib.parse

calls = []  # ("post"|"patch", path, payload) in order
# "fresh": nothing exists yet. "published" / "revision": every SAMPLE row exists already and each rule is
# Published, or is a Draft that has a published revision (both locked by the revision guard).
scenario = {"mode": "fresh"}


def fake_get(path):
    entity = path.split("?")[0]
    query = urllib.parse.unquote(path)
    if entity.startswith("asx_rules("):
        if scenario["mode"] == "published":
            return {"statuscode": 753840000, "_asx_publishedrevision_value": "rev"}
        if scenario["mode"] == "revision":
            return {"statuscode": 1, "_asx_publishedrevision_value": "rev"}
        return {"statuscode": 1}
    if scenario["mode"] != "fresh" and "asx_name eq" in query:
        return {"value": [{entity[:-1] + "id": f"existing-{entity}"}]}
    return {"value": []}


def fake_post(path, payload, **_):
    calls.append(("post", path, payload))
    return f"id-{len(calls)}"


def fake_patch(path, payload, **_):
    calls.append(("patch", path, payload))


fake = types.ModuleType("_dv")
fake.urllib = urllib
fake.get, fake.post, fake.patch = fake_get, fake_post, fake_patch
fake.resolve_nav_property = lambda e, r, a: f"NAV_{e}_{a}"
sys.modules["_dv"] = fake

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("author_rules", os.path.join(here, "author-rules.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def run(mode):
    """Runs main() against the fake in the given scenario; returns its printed output."""
    scenario["mode"] = mode
    calls.clear()
    mod.RULES.clear()
    mod.LOCKED.clear()
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        mod.main()
    return out.getvalue()


def test_rules_are_created_as_drafts_and_published_last():
    run("fresh")
    rule_posts = [c for c in calls if c[0] == "post" and c[1] == "asx_rules"]
    assert len(rule_posts) == 6 and all("statuscode" not in c[2] for c in rule_posts)
    patches = [i for i, c in enumerate(calls) if c[0] == "patch"]
    assert len(patches) == 6 and all(calls[i][2] == {"statuscode": mod.PUBLISHED} for i in patches)
    last_post = max(i for i, c in enumerate(calls) if c[0] == "post")
    assert min(patches) > last_post, "every rule is published only after all its rows are created"


def test_every_action_gets_a_root_and_a_test_before_publishing():
    run("fresh")
    roots = [c for c in calls if c[1] == "asx_actionconditiongroups"]
    tests = [c for c in calls if c[1] == "asx_actionconditiontests"]
    assert len(roots) == 6 and len(tests) == 6
    assert all("asx_fireon" not in c[2] for c in calls)


def test_a_rerun_skips_the_trees_of_published_rules():
    # The guard refuses writes to a published rule's rows; the migration converts those rules instead.
    for mode in ("published", "revision"):
        out = run(mode)
        tree_posts = [c for c in calls if c[1] in ("asx_actionconditiongroups", "asx_actionconditiontests")]
        assert tree_posts == [], f"{mode}: no tree rows are written for a published rule"
        skips = [line for line in out.splitlines() if line.startswith("[skip] Fires when tree for 'SAMPLE R")]
        assert len(skips) == 6, f"{mode}: one skip line per action, got:\n{out}"


if __name__ == "__main__":
    test_rules_are_created_as_drafts_and_published_last()
    test_every_action_gets_a_root_and_a_test_before_publishing()
    test_a_rerun_skips_the_trees_of_published_rules()
    print("OK")
