"""Tests for reset-data.py's $batch delete. No Dataverse needed: _dv is replaced by a fake.

    python scripts/perf/test_reset_data.py
"""
import contextlib
import importlib.util
import io
import os
import sys
import types
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))


class _FakeDv(types.ModuleType):
    """Stands in for _dv (whose import reads .env and fetches a token). send() answers with the next
    canned $batch body and records each request."""

    BASE = "https://dev.example/api/data/v9.2"
    urllib = urllib

    def __init__(self):
        super().__init__("_dv")
        self.responses, self.sent = [], []

    def send(self, method, url, body, **kw):
        self.sent.append(body)
        return None, self.responses.pop(0)

    def get(self, path):
        raise AssertionError("not used")

    def delete(self, path):
        raise AssertionError("not used")


fake = _FakeDv()
sys.modules["_dv"] = fake
_spec = importlib.util.spec_from_file_location("reset_data", os.path.join(HERE, "reset-data.py"))
rd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rd)


def _batch_response(*statuses):
    parts = []
    for status in statuses:
        parts += ["--batchresponse_x", "Content-Type: application/http", "", f"HTTP/1.1 {status}", ""]
    return "\r\n".join(parts + ["--batchresponse_x--"])


def test_a_row_already_gone_counts_as_deleted():
    # A batch retried after a client timeout, or a row a cascade already removed: 404 means the row is gone,
    # which is what the reset wants.
    fake.responses = [_batch_response("204 No Content", "404 Not Found", "204 No Content")]
    rd._batch_delete("perf_child1s", ["a", "b", "c"])
    assert len(fake.sent) == 1


def test_any_other_failed_part_still_stops_the_reset():
    fake.sent.clear()
    fake.responses = [_batch_response("204 No Content", "403 Forbidden")]
    try:
        rd._batch_delete("perf_child1s", ["a", "b"])
        assert False, "expected SystemExit"
    except SystemExit as e:
        assert "1 part(s) failed" in str(e) and "403" in str(e)


def test_a_reset_forgets_the_kept_data_before_deleting_anything():
    # An interrupted reset leaves DEV half-cleared: the state file must already be gone by then.
    order = []
    saved = (rd.datastate.clear, rd.delete_rules, rd.delete_data_table)
    rd.datastate.clear = lambda *a: order.append("clear")
    rd.delete_rules = lambda: order.append("rules")
    rd.delete_data_table = lambda *a, **k: order.append("data")
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            rd.main()
    finally:
        rd.datastate.clear, rd.delete_rules, rd.delete_data_table = saved
    assert order[0] == "clear" and order.count("clear") == 1 and "rules" in order


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("OK")
