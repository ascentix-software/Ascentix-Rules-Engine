"""Create the 'Rules Engine Sample' model-driven app (appmodule + sitemap over the
four sample_ tables), validate, and publish. Idempotent. Run from repo root after
create-schema.py:  python scripts/sample-app/create-app.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "sample-app"))
import _dv  # noqa: E402
from _dv import get, patch, post  # noqa: E402

CLIENTTYPE_UNIFIED = 4  # Unified Interface (2 = legacy web client)

DEFAULT_ICON = "953b9fac-1e5e-e611-80d6-00155ded156f"  # platform default app icon web resource
APP_NAME = "Rules Engine Sample"
APP_UNIQUE = "RulesEngineSample"  # auto-prefixed with the solution publisher prefix (sample_)
SITEMAP_NAME = "RulesEngineSampleSiteMap"

SITEMAP_XML = (
    "<SiteMap>"
    '<Area Id="sample_area" Title="Rules Engine Sample" ShowGroups="true">'
    '<Group Id="sample_group" Title="Sample">'
    '<SubArea Id="nav_order" Entity="sample_order" Title="Orders" />'
    '<SubArea Id="nav_customer" Entity="sample_customer" Title="Customers" />'
    '<SubArea Id="nav_product" Entity="sample_product" Title="Products" />'
    '<SubArea Id="nav_orderline" Entity="sample_orderline" Title="Order Lines" />'
    "</Group></Area></SiteMap>"
)


def q(expr):
    return _dv.urllib.parse.quote(expr)


def find_app():
    flt = q(f"name eq '{APP_NAME}'")
    vals = get(f"appmodules?$select=appmoduleid,uniquename,name&$filter={flt}")["value"]
    if vals:
        return vals[0]["appmoduleid"]
    # newly created apps are unpublished and absent from the normal query
    vals = get("appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()"
               "?$select=appmoduleid,name")["value"]
    for v in vals:
        if v.get("name") == APP_NAME:
            return v["appmoduleid"]
    return None


def find_sitemap():
    flt = q(f"sitemapnameunique eq 'sample_{SITEMAP_NAME}'")
    try:
        vals = get(f"sitemaps?$select=sitemapid,sitemapnameunique&$filter={flt}")["value"]
        return vals[0]["sitemapid"] if vals else None
    except SystemExit:
        # sitemapnameunique may not be filterable; fall back to name
        flt = q(f"sitemapname eq '{SITEMAP_NAME}'")
        vals = get(f"sitemaps?$select=sitemapid,sitemapname&$filter={flt}")["value"]
        return vals[0]["sitemapid"] if vals else None


def main():
    app_id = find_app()
    if app_id:
        print(f"[skip] appmodule {app_id}")
    else:
        app_id = post("appmodules", {
            "name": APP_NAME,
            "uniquename": APP_UNIQUE,
            "webresourceid": DEFAULT_ICON,
            "clienttype": CLIENTTYPE_UNIFIED,
        })
        print(f"[create] appmodule {app_id}")

    # ensure Unified Interface (fixes an app previously created as legacy web client)
    patch(f"appmodules({app_id})", {"clienttype": CLIENTTYPE_UNIFIED}, solution=False)

    sm_id = find_sitemap()
    if sm_id:
        print(f"[skip] sitemap {sm_id}")
    else:
        sm_id = post("sitemaps", {
            "sitemapname": SITEMAP_NAME,
            "sitemapnameunique": f"sample_{SITEMAP_NAME}",
            "sitemapxml": SITEMAP_XML,
        })
        print(f"[create] sitemap {sm_id}")

    # associate sitemap (idempotent server-side)
    post("AddAppComponents", {
        "AppId": app_id,
        "Components": [{"sitemapid": sm_id, "@odata.type": "Microsoft.Dynamics.CRM.sitemap"}],
    }, solution=False)
    print("[add] sitemap -> app")

    # add the four tables as first-class app components (silences the "no entity" warning)
    ents = []
    for t in ["sample_order", "sample_customer", "sample_product", "sample_orderline"]:
        mid = get(f"EntityDefinitions(LogicalName='{t}')?$select=MetadataId")["MetadataId"]
        ents.append({"@odata.type": "Microsoft.Dynamics.CRM.entity", "entityid": mid})
    post("AddAppComponents", {"AppId": app_id, "Components": ents}, solution=False)
    print("[add] 4 tables -> app")

    res = get(f"ValidateApp(AppModuleId={app_id})")
    vr = res.get("AppValidationResponse", res)
    print("[validate] success =", vr.get("ValidationSuccess"))
    for issue in vr.get("ValidationIssueList", []):
        print(f"   {issue.get('ErrorType')}: {issue.get('Message')}")

    post("PublishXml", {
        "ParameterXml": f"<importexportxml><appmodules><appmodule>{app_id}</appmodule></appmodules></importexportxml>",
    }, solution=False)
    print("[publish] done")
    print(f"\nDONE. appmoduleid={app_id}")


if __name__ == "__main__":
    main()
