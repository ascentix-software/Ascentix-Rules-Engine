"""Shared Dataverse Web API helper for the perf provisioning scripts.

Uses scripts/auth.py for the shared DataverseCLI token. All writes go into the
PerfHarness solution via the MSCRM.SolutionName header. Raw Web API
(urllib) — the same pattern proven for the Custom API + web resource deploys.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.getcwd(), "scripts"))
from auth import load_env, get_token, get_plugin_headers  # noqa: E402

load_env()
BASE = os.environ["DATAVERSE_URL"].rstrip("/") + "/api/data/v9.2"
SOLUTION = "PerfHarness"
PREFIX = "perf"

_token = get_token()


def _headers(write, solution):
    h = get_plugin_headers("perf-harness", _token)
    h["Accept"] = "application/json"
    h["OData-MaxVersion"] = "4.0"
    h["OData-Version"] = "4.0"
    if write:
        h["Content-Type"] = "application/json; charset=utf-8"
        if solution:
            h["MSCRM.SolutionName"] = SOLUTION
    return h


class DataverseError(Exception):
    """A Web API call that failed. status is the HTTP status, None for a timeout or a dropped connection."""

    def __init__(self, method, path, status, message):
        super().__init__(f"{method} {path}: {status or 'no response'}: {message}")
        self.status = status
        self.message = message


def _error_message(detail):
    try:
        return json.loads(detail)["error"]["message"]
    except (ValueError, KeyError, TypeError):
        return detail


_urlopen = urllib.request.urlopen  # the HTTP transport; test_dv.py swaps in a fake
_sleep = time.sleep                 # the pause between dropped-connection retries; test_dv.py swaps it out

# A dropped connection (no response) is retried only where repeating the call is harmless: a POST may
# already have created its row on the server, so it is never resent here (callers that can check, like
# generate.py's bulk_create, recover on their own).
IDEMPOTENT_METHODS = ("GET", "PATCH", "PUT", "DELETE")
CONNECTION_ATTEMPTS = 3


def send(method, url, data=None, *, write=False, solution=False, content_type=None, timeout=None):
    """Every harness HTTP call goes through here: one call with the current token, retried once with a
    fresh token on 401 (a long load or ladder outlives a token), and up to CONNECTION_ATTEMPTS times in all
    when the connection drops without a response on an idempotent method. The headers are rebuilt per
    attempt so a retry carries the current token. Returns (response headers, body text); any other
    HTTPError propagates, as does a second 401 or the last dropped connection."""
    global _token
    refreshed, drops = False, 0
    while True:
        headers = _headers(write, solution)
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with _urlopen(req, timeout=timeout) as r:
                return r.headers, r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code == 401 and not refreshed:
                refreshed = True
                _token = get_token()
                continue
            raise
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            drops += 1
            if method not in IDEMPOTENT_METHODS or drops >= CONNECTION_ATTEMPTS:
                raise
            _sleep(5 * drops)


def request(method, path, payload=None, *, solution=False, timeout=180):
    """One Web API call returning (headers, body). Raises DataverseError instead of exiting, so a
    driver can record the failure; a 401 and a dropped connection are retried as send describes."""
    url = path if path.startswith("http") else f"{BASE}/{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    try:
        headers, body = send(method, url, data, write=payload is not None, solution=solution, timeout=timeout)
        return headers, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        raise DataverseError(method, path, e.code, _error_message(e.read().decode())) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise DataverseError(method, path, None, str(e)) from None


def _req(method, path, payload=None, solution=True):
    try:
        return request(method, path, payload, solution=solution, timeout=None)
    except DataverseError as e:
        raise SystemExit(f"ERROR {method} {path}: {e.status}\n{e.message}")


def get(path):
    _, body = _req("GET", path)
    return body


def post(path, payload, *, solution=True):
    headers, body = _req("POST", path, payload, solution=solution)
    loc = headers.get("OData-EntityId", "")
    return loc.split("(")[-1].rstrip(")") if "(" in loc else body


def patch(path, payload, *, solution=True):
    _req("PATCH", path, payload, solution=solution)


def delete(path):
    _req("DELETE", path)


def whoami():
    return get("WhoAmI")


def label(text, lcid=1033):
    return {"@odata.type": "Microsoft.Dynamics.CRM.Label",
            "LocalizedLabels": [{"@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
                                  "Label": text, "LanguageCode": lcid}]}


def publish_all():
    _req("POST", "PublishAllXml", {})


def resolve_nav_property(entity, referenced_entity, referencing_attribute):
    """Return the ReferencingEntityNavigationPropertyName for a lookup, for @odata.bind."""
    rels = get(f"EntityDefinitions(LogicalName='{entity}')/ManyToOneRelationships"
               f"?$select=ReferencingEntityNavigationPropertyName,ReferencedEntity,ReferencingAttribute")
    for r in rels["value"]:
        if r["ReferencedEntity"] == referenced_entity and r["ReferencingAttribute"] == referencing_attribute:
            return r["ReferencingEntityNavigationPropertyName"]
    raise SystemExit(f"No nav property: {entity}.{referencing_attribute} -> {referenced_entity}")
