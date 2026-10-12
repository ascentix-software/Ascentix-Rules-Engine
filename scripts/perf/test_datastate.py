"""Unit tests for datastate.py (no Dataverse). Run: python scripts/perf/test_datastate.py"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import datastate  # noqa: E402

COUNTS = {"perf_root": 5, "perf_child1": 50000, "asx_rule": 101}


def test_a_saved_step_matches_only_the_same_fingerprint_and_the_same_counts():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "nested", "state.json")
        fp = datastate.fingerprint("S2", 10000, ["--records", 5, "--rows-per-root", 10000], code_hash="h1")
        datastate.save(fp, COUNTS, path)
        state = datastate.load(path)
        assert datastate.matches(state, fp, dict(COUNTS))
        assert not datastate.matches(state, datastate.fingerprint("S2", 5000, fp["generateArgs"], "h1"), COUNTS)
        assert not datastate.matches(state, datastate.fingerprint("S1", 10000, fp["generateArgs"], "h1"), COUNTS)
        assert not datastate.matches(state, datastate.fingerprint("S2", 10000, fp["generateArgs"], "h2"), COUNTS)
        assert not datastate.matches(state, fp, {**COUNTS, "perf_child1": 49999})
        assert not datastate.matches(None, fp, COUNTS)


def test_clear_removes_the_state_and_load_survives_a_missing_or_broken_file():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "state.json")
        datastate.clear(path)                                   # nothing there: no error
        assert datastate.load(path) is None
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not json")
        assert datastate.load(path) is None
        datastate.save(datastate.fingerprint("S1", 100, [], "h"), COUNTS, path)
        datastate.clear(path)
        assert datastate.load(path) is None


def test_the_generator_hash_ignores_line_endings_and_follows_content():
    with tempfile.TemporaryDirectory() as d:
        for name, body in (("a.py", b"x = 1\r\n"), ("b.py", b"x = 1\n")):
            with open(os.path.join(d, name), "wb") as f:
                f.write(body)
        assert datastate.generator_hash(("a.py",), d) == datastate.generator_hash(("b.py",), d)
        with open(os.path.join(d, "b.py"), "wb") as f:
            f.write(b"x = 2\n")
        assert datastate.generator_hash(("a.py",), d) != datastate.generator_hash(("b.py",), d)


def test_the_state_file_lives_in_the_git_ignored_perf_folder():
    assert datastate.STATE_FILE.replace("\\", "/").endswith("docs/perf/.data-state.json")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("OK")
