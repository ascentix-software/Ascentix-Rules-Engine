"""Offline test for author-rules.py ordering (no Dataverse: _dv is replaced by a recording fake).
Run from the repo root: python scripts/sample-app/test_author_rules.py"""
import importlib.util
import os
import sys
import types
import urllib.parse

calls = []  # ("post"|"patch", path, payload) in order
store = {}  # entity set -> list of records


def fake_get(path):
    entity = path.split("?")[0]
    if entity.startswith("asx_rules("):
        return {"statuscode": 1}
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
mod.main()


def test_rules_are_created_as_drafts_and_published_last():
    rule_posts = [c for c in calls if c[0] == "post" and c[1] == "asx_rules"]
    assert len(rule_posts) == 6 and all("statuscode" not in c[2] for c in rule_posts)
    patches = [i for i, c in enumerate(calls) if c[0] == "patch"]
    assert len(patches) == 6 and all(calls[i][2] == {"statuscode": mod.PUBLISHED} for i in patches)
    last_post = max(i for i, c in enumerate(calls) if c[0] == "post")
    assert min(patches) > last_post, "every rule is published only after all its rows are created"


def test_every_action_gets_a_root_and_a_test_before_publishing():
    roots = [c for c in calls if c[1] == "asx_actionconditiongroups"]
    tests = [c for c in calls if c[1] == "asx_actionconditiontests"]
    assert len(roots) == 6 and len(tests) == 6
    assert all("asx_fireon" not in c[2] for c in calls)


if __name__ == "__main__":
    test_rules_are_created_as_drafts_and_published_last()
    test_every_action_gets_a_root_and_a_test_before_publishing()
    print("OK")
