"""Unit tests for _dv's token handling with a fake auth module and a fake HTTP transport (no network, no .env).
Run: python scripts/perf/test_dv.py"""
import http.client
import importlib.util
import io
import os
import sys
import types
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# scripts/auth.py reads .env and fetches a token at import; the tests replace it before _dv loads.
_auth = types.ModuleType("auth")
_auth.load_env = lambda: None
_auth.get_token = lambda: "fresh"
_auth.get_plugin_headers = lambda skill, token=None: {"User-Agent": "test", "Authorization": f"Bearer {token}"}
sys.modules["auth"] = _auth
_saved_url = os.environ.get("DATAVERSE_URL")
os.environ["DATAVERSE_URL"] = "https://fake.invalid"
import _dv  # noqa: E402
import generate  # noqa: E402

_spec = importlib.util.spec_from_file_location("reset_data", os.path.join(HERE, "reset-data.py"))
reset_data = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reset_data)
if _saved_url is None:
    del os.environ["DATAVERSE_URL"]
else:
    os.environ["DATAVERSE_URL"] = _saved_url


class _Response:
    def __init__(self, body, headers=None):
        self._body, self.headers = body.encode("utf-8"), headers or {}

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeTransport:
    """Answers each call with the next reply: an HTTP status to raise, or a body to return. Records the
    token and the request of every call."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.tokens = []
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        self.tokens.append(req.get_header("Authorization"))
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        if isinstance(reply, int):
            raise urllib.error.HTTPError(req.full_url, reply, "error", {}, io.BytesIO(b'{"error":{"message":"no"}}'))
        return _Response(reply)


def _with(transport):
    _dv._token = "stale"
    _dv._urlopen = transport
    _dv._sleep = lambda seconds: None
    return transport


def _drop():
    return http.client.RemoteDisconnected("Remote end closed connection without response")


def test_request_retries_once_with_a_fresh_token_on_401():
    t = _with(FakeTransport(401, '{"value": []}'))
    assert _dv.request("GET", "perf_roots?$top=1")[1] == {"value": []}
    assert t.tokens == ["Bearer stale", "Bearer fresh"]


def test_request_gives_up_after_a_second_401_and_never_retries_other_errors():
    t = _with(FakeTransport(401, 401))
    try:
        _dv.request("GET", "perf_roots?$top=1")
        assert False, "expected DataverseError"
    except _dv.DataverseError as e:
        assert e.status == 401 and len(t.tokens) == 2
    t = _with(FakeTransport(500))
    try:
        _dv.request("GET", "perf_roots?$top=1")
        assert False, "expected DataverseError"
    except _dv.DataverseError as e:
        assert e.status == 500 and e.message == "no" and t.tokens == ["Bearer stale"]


def test_a_dropped_connection_is_retried_for_reads_and_idempotent_writes():
    # S3's 10,000 step lost its data load to one dropped connection on 2026-10-04.
    t = _with(FakeTransport(_drop(), urllib.error.URLError(ConnectionResetError(10054, "reset")), '{"value": []}'))
    assert _dv.request("GET", "perf_roots?$top=1")[1] == {"value": []}
    assert len(t.requests) == 3
    t = _with(FakeTransport(_drop(), ""))
    _dv.request("PATCH", "perf_roots(r-1)", {"perf_text": "x"})
    assert len(t.requests) == 2


def test_a_dropped_connection_gives_up_after_three_attempts():
    t = _with(FakeTransport(_drop(), _drop(), _drop()))
    try:
        _dv.request("GET", "perf_roots?$top=1")
        assert False, "expected DataverseError"
    except _dv.DataverseError as e:
        assert e.status is None and "Remote end closed" in e.message and len(t.requests) == 3


def test_a_dropped_post_is_never_resent_by_the_client():
    # The server may have created the row before the connection dropped: resending would duplicate it.
    t = _with(FakeTransport(_drop(), '{"x": 1}'))
    try:
        _dv.request("POST", "perf_roots", {"perf_name": "PERF-1"})
        assert False, "expected DataverseError"
    except _dv.DataverseError as e:
        assert e.status is None and len(t.requests) == 1


def test_generate_batch_create_retries_once_with_a_fresh_token_on_401():
    # A 50,000-root load outlives a token: chunk 228 of 500 got a 401 on DEV.
    created = "--batchresponse\r\nOData-EntityId: https://fake.invalid/api/data/v9.2/perf_roots(g-1)\r\n"
    t = _with(FakeTransport(401, created))
    assert generate.batch_post([("perf_roots", {"perf_name": "PERF-1"})]) == ["g-1"]
    assert t.tokens == ["Bearer stale", "Bearer fresh"]
    sent = t.requests[-1]
    assert sent.full_url.endswith("/$batch") and sent.get_header("Content-type").startswith("multipart/mixed; boundary=")
    assert sent.get_header("Mscrm.solutionname") == _dv.SOLUTION


def test_reset_batch_delete_retries_once_with_a_fresh_token_on_401():
    t = _with(FakeTransport(401, "--batchresponse\r\nHTTP/1.1 204 No Content\r\n"))
    reset_data._batch_delete("perf_roots", ["r-1"])
    assert t.tokens == ["Bearer stale", "Bearer fresh"]
    sent = t.requests[-1]
    assert sent.get_header("Content-type").startswith("multipart/mixed") and sent.get_header("Mscrm.solutionname") is None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("OK")
