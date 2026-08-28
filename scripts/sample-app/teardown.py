"""Remove the sample app: rule records, seed data, sample_ tables, solution, publisher.
Idempotent. Run from repo root:  python scripts/sample-app/teardown.py
DESTRUCTIVE — deletes the sample_ schema + all SAMPLE/sample_ data in the dev env,
plus the "Rules Engine Sample" model-driven app + its sitemap.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "sample-app"))
import _dv  # noqa: E402
from _dv import get, delete  # noqa: E402


def delete_by_name(entityset, idfield, namefield, prefix):
    flt = _dv.urllib.parse.quote(f"startswith({namefield},'{prefix}')")
    recs = get(f"{entityset}?$select={idfield}&$filter={flt}")["value"]
    for r in recs:
        delete(f"{entityset}({r[idfield]})")
    print(f"[delete] {entityset}: {len(recs)} record(s) matching {namefield} startswith '{prefix}'")


def delete_all(entityset, idfield):
    recs = get(f"{entityset}?$select={idfield}")["value"]
    for r in recs:
        delete(f"{entityset}({r[idfield]})")
    print(f"[delete] {entityset}: {len(recs)} record(s)")


def drop_table(logical):
    flt = _dv.urllib.parse.quote(f"LogicalName eq '{logical}'")
    r = get(f"EntityDefinitions?$select=MetadataId&$filter={flt}")
    if not r["value"]:
        print(f"[skip] table {logical} (absent)"); return
    delete(f"EntityDefinitions({r['value'][0]['MetadataId']})")
    print(f"[delete] table {logical}")


def main():
    # 1. rule graph (children first: actions, conditions, groups, then rules, then SAMPLE tableconfigs)
    delete_by_name("asx_ruleactions", "asx_ruleactionid", "asx_name", "SAMPLE ")
    delete_by_name("asx_ruleconditions", "asx_ruleconditionid", "asx_name", "SAMPLE ")
    delete_by_name("asx_conditiongroups", "asx_conditiongroupid", "asx_name", "SAMPLE ")
    delete_by_name("asx_rules", "asx_ruleid", "asx_name", "SAMPLE ")
    # SAMPLE tableconfig nodes — delete leaf-to-root (asx_parenttable self-ref may be restrict-on-delete)
    for tc_name in [
        "SAMPLE Parent Customer (lookup)",
        "SAMPLE Product (lookup)",
        "SAMPLE Customer (lookup)",
        "SAMPLE Order Line (child)",
        "SAMPLE Order (root)",
    ]:
        flt = _dv.urllib.parse.quote(f"asx_name eq '{tc_name}'")
        for r in get(f"asx_tableconfigs?$select=asx_tableconfigid&$filter={flt}")["value"]:
            delete(f"asx_tableconfigs({r['asx_tableconfigid']})")
        print(f"[delete] asx_tableconfigs '{tc_name}'")

    # 2. seed data (lines before orders; customers last for the self-ref/parent)
    delete_all("sample_orderlines", "sample_orderlineid")
    delete_all("sample_orders", "sample_orderid")
    delete_all("sample_products", "sample_productid")
    # customers: delete children (with a parent) before parents to satisfy the self-ref
    custs = get("sample_customers?$select=sample_customerid,_sample_parentcustomerid_value")["value"]
    for c in [x for x in custs if x.get("_sample_parentcustomerid_value")]:
        delete(f"sample_customers({c['sample_customerid']})")
    for c in [x for x in custs if not x.get("_sample_parentcustomerid_value")]:
        delete(f"sample_customers({c['sample_customerid']})")
    print(f"[delete] sample_customers: {len(custs)} record(s)")

    # 2b. model-driven app + sitemap (delete before tables — the app references them)
    app_flt = _dv.urllib.parse.quote("name eq 'Rules Engine Sample'")
    apps = get(f"appmodules?$select=appmoduleid&$filter={app_flt}")["value"]
    for a in apps:
        delete(f"appmodules({a['appmoduleid']})")
    print(f"[delete] appmodule 'Rules Engine Sample': {len(apps)}")
    sm_flt = _dv.urllib.parse.quote("sitemapnameunique eq 'sample_RulesEngineSampleSiteMap'")
    sms = get(f"sitemaps?$select=sitemapid&$filter={sm_flt}")["value"]
    for s in sms:
        delete(f"sitemaps({s['sitemapid']})")
    print(f"[delete] sitemap: {len(sms)}")

    # 3. tables (lines/orders/products/customers — drop child-referencing tables first)
    drop_table("sample_orderline")
    drop_table("sample_order")
    drop_table("sample_product")
    drop_table("sample_customer")

    # 4. solution + publisher
    sol_flt = _dv.urllib.parse.quote("uniquename eq 'RulesEngineSampleApp'")
    sol = get(f"solutions?$select=solutionid&$filter={sol_flt}")["value"]
    if sol:
        delete(f"solutions({sol[0]['solutionid']})")
        print("[delete] solution RulesEngineSampleApp")
    pub_flt = _dv.urllib.parse.quote("uniquename eq 'ascentixsample'")
    pub = get(f"publishers?$select=publisherid&$filter={pub_flt}")["value"]
    if pub:
        try:
            delete(f"publishers({pub[0]['publisherid']})")
            print("[delete] publisher (prefix sample)")
        except SystemExit:
            print("[skip] publisher (still referenced), delete it manually if you want it gone")

    print("\nDONE. sample app removed.")


if __name__ == "__main__":
    main()
