"""What perf data a run left on DEV, so a re-run of the same step reuses it instead of resetting and
generating again (hours at the top of a ladder).

The state is a small JSON file (docs/perf/.data-state.json, git-ignored with the rest of docs/perf): the
fingerprint of the step that generated the data (scenario, step, generate.py's arguments and a hash of the
generator code) and the PERF row counts on DEV right after generating. A step reuses the data only when its
fingerprint is the same AND DEV still holds exactly those counts, so data changed or cleared since (by hand,
by reset-data.py, by another scenario) is never mistaken for a match. reset-data.py deletes the file first.

Pure: no Dataverse access. run-scenario.py supplies the counts.
"""
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.normpath(os.path.join(HERE, "..", "..", "docs", "perf", ".data-state.json"))
GENERATOR_FILES = ("generate.py", "profiles.py")


def generator_hash(files=GENERATOR_FILES, here=HERE):
    """A hash of the code that shapes the data and rules: any change to it invalidates kept data."""
    digest = hashlib.sha256()
    for name in files:
        with open(os.path.join(here, name), "rb") as f:
            digest.update(f.read().replace(b"\r\n", b"\n"))   # the same on any checkout's line endings
    return digest.hexdigest()


def fingerprint(scenario, step, generate_args, code_hash=None):
    return {"scenario": scenario, "step": str(step), "generateArgs": [str(a) for a in generate_args],
            "generatorHash": code_hash if code_hash is not None else generator_hash()}


def load(path=STATE_FILE):
    """The saved state, or None when there is none or it can't be read."""
    try:
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        return None
    return state if isinstance(state, dict) else None


def save(fp, counts, path=STATE_FILE):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"fingerprint": fp, "counts": counts}, f, indent=2, sort_keys=True)


def clear(path=STATE_FILE):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def matches(state, fp, counts):
    """True when the saved state is this step's data and DEV still holds exactly what was generated."""
    return bool(state) and state.get("fingerprint") == fp and state.get("counts") == counts
