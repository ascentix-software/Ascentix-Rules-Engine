"""Shared Dataverse Web API helper for the sample-app provisioning scripts.

Uses scripts/auth.py for the shared DataverseCLI token. All writes go into the
RulesEngineSampleApp solution via the MSCRM.SolutionUniqueName header (the
previously used ``MSCRM.SolutionName`` is silently ignored by Dataverse, which
left every component in the default solution — found on a Tier-C trial org;
create-schema.py's ensure_in_solution step repairs such orgs). Raw
Web API (urllib) — the same pattern proven for the Custom API + web resource
deploys.
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
SOLUTION = "RulesEngineSampleApp"
PREFIX = "sample"

_token = get_token()


def _headers(write, solution):
    h = get_plugin_headers("sample-app", _token)
    h["Accept"] = "application/json"
    h["OData-MaxVersion"] = "4.0"
    h["OData-Version"] = "4.0"
    if write:
        h["Content-Type"] = "application/json; charset=utf-8"
        if solution:
            h["MSCRM.SolutionUniqueName"] = SOLUTION
    return h


def _req(method, path, payload=None, solution=True):
    url = path if path.startswith("http") else f"{BASE}/{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=_headers(payload is not None, solution), method=method)
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read().decode()
            return r.headers, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        raise SystemExit(f"ERROR {method} {path}: {e.code}\n{detail}")


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


_lang = None  # (base_lcid, frozenset(provisioned lcids)) — fetched once per process


def org_languages():
    """(base LCID, provisioned LCIDs) of the target org, fetched once. Metadata creates must carry
    a label in the base language and may only carry labels for provisioned languages; DEV is
    English-only (1033) while the Tier-C trial org is French-only (1036)."""
    global _lang
    if _lang is None:
        orgs = get("organizations?$select=languagecode")["value"]
        base = int(orgs[0]["languagecode"]) if orgs else 1033
        prov = get("RetrieveProvisionedLanguages").get("RetrieveProvisionedLanguages") or [base]
        _lang = (base, frozenset(int(x) for x in prov) | {base})
    return _lang


def label(text, lcid=1033):
    """Dataverse Label carrying ``text`` for the org base language, plus ``lcid`` when that language
    is provisioned (same English text — the fixture model is not localized; it just has to be
    creatable on any base language). On an English org this is exactly one 1033 label."""
    base, provisioned = org_languages()
    lcids = [base] + ([lcid] if lcid != base and lcid in provisioned else [])
    return {"@odata.type": "Microsoft.Dynamics.CRM.Label",
            "LocalizedLabels": [{"@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
                                  "Label": text, "LanguageCode": code} for code in lcids]}


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
