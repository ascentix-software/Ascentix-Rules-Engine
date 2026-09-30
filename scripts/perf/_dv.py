"""Shared Dataverse Web API helper for the perf provisioning scripts.

Uses scripts/auth.py for the shared DataverseCLI token. All writes go into the
PerfHarness solution via the MSCRM.SolutionName header. Raw Web API
(urllib) — the same pattern proven for the Custom API + web resource deploys.
"""
import json
import os
import sys
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


def request(method, path, payload=None, *, solution=False, timeout=180):
    """One Web API call returning (headers, body). Raises DataverseError instead of exiting, so a
    driver can record the failure; retries once with a fresh token on 401 (long ladders outlive a token)."""
    global _token
    url = path if path.startswith("http") else f"{BASE}/{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    for attempt in (1, 2):
        req = urllib.request.Request(url, data=data, headers=_headers(payload is not None, solution), method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read().decode()
                return r.headers, (json.loads(body) if body else None)
        except urllib.error.HTTPError as e:
            detail = e.read().decode()
            if e.code == 401 and attempt == 1:
                _token = get_token()
                continue
            raise DataverseError(method, path, e.code, _error_message(detail)) from None
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
