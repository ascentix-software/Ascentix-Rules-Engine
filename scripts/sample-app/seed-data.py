"""Seed sample customers, products, orders, and order lines (idempotent by name).
Run from repo root after create-schema.py:  python scripts/sample-app/seed-data.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "sample-app"))
import _dv  # noqa: E402
from _dv import get, post, resolve_nav_property  # noqa: E402

# nav properties for @odata.bind (resolved once from metadata)
NAV_ORDER_CUSTOMER = resolve_nav_property("sample_order", "sample_customer", "sample_customerid")
NAV_CUST_PARENT = resolve_nav_property("sample_customer", "sample_customer", "sample_parentcustomerid")
NAV_LINE_ORDER = resolve_nav_property("sample_orderline", "sample_order", "sample_orderid")
NAV_LINE_PRODUCT = resolve_nav_property("sample_orderline", "sample_product", "sample_productid")


def ensure(entityset, name, payload):
    flt = _dv.urllib.parse.quote(f"sample_name eq '{name}'")
    existing = get(f"{entityset}?$filter={flt}")
    if existing["value"]:
        rec = existing["value"][0]
        idkey = next(k for k in rec if k.endswith("id") and k.startswith("sample_"))
        print(f"[skip] {entityset} '{name}'")
        return rec[idkey]
    rid = post(entityset, {"sample_name": name, **payload})
    print(f"[create] {entityset} '{name}' {rid}")
    return rid


def main():
    # --- customers (Globex Corp -> parent of Globex Retail) ---
    globex = ensure("sample_customers", "Globex Corporation", {
        "sample_email": "ap@globex.example", "sample_phone": "416-555-0100",
        "sample_postalcode": "M5V 2T6", "sample_creditlimit": 50000,
        "sample_segments": "2,3",  # Wholesale, VIP (multiselect = comma-separated ints)
    })
    ensure("sample_customers", "Globex Retail", {
        "sample_email": "ar@globexretail.example", "sample_phone": "416-555-0111",
        "sample_postalcode": "M5V 2T7", "sample_creditlimit": 10000,
        "sample_segments": "1",  # Retail
        f"{NAV_CUST_PARENT}@odata.bind": f"/sample_customers({globex})",
    })
    ensure("sample_customers", "Initech", {
        "sample_email": "not-an-email", "sample_phone": "call me",
        "sample_postalcode": "ZZZZZ", "sample_creditlimit": 5000,
        "sample_segments": "1",  # Retail; deliberately bad email/phone/postal
    })

    # --- products ---
    widget = ensure("sample_products", "Widget", {"sample_unitprice": 25, "sample_category": 1})
    gadget = ensure("sample_products", "Gadget", {"sample_unitprice": 120, "sample_category": 1})
    crm = ensure("sample_products", "CRM License", {"sample_unitprice": 1200, "sample_category": 2})
    ensure("sample_products", "Onboarding Service",
           {"sample_unitprice": 2000, "sample_category": 3, "sample_discontinued": False})

    # --- orders + lines ---
    # ORD-1001 clean (Globex), 2 lines total 220
    o1 = ensure("sample_orders", "ORD-1001", {
        "sample_status": 1, "sample_isexpedited": False, "sample_ordertotal": 220,
        "sample_contactemail": "buyer@globex.example", "sample_contactphone": "416-555-0100",
        "sample_shippingpostalcode": "M5V 2T6",
        f"{NAV_ORDER_CUSTOMER}@odata.bind": f"/sample_customers({globex})",
    })
    ensure("sample_orderlines", "ORD-1001 / Widget", {
        "sample_quantity": 4, "sample_lineamount": 100,
        f"{NAV_LINE_ORDER}@odata.bind": f"/sample_orders({o1})",
        f"{NAV_LINE_PRODUCT}@odata.bind": f"/sample_products({widget})"})
    ensure("sample_orderlines", "ORD-1001 / Gadget", {
        "sample_quantity": 1, "sample_lineamount": 120,
        f"{NAV_LINE_ORDER}@odata.bind": f"/sample_orders({o1})",
        f"{NAV_LINE_PRODUCT}@odata.bind": f"/sample_products({gadget})"})

    # ORD-1002 over-limit (Initech, limit 5000) + bad email; 1 line total 6000
    o2 = ensure("sample_orders", "ORD-1002", {
        "sample_status": 2, "sample_isexpedited": False, "sample_ordertotal": 6000,
        "sample_contactemail": "broken-email", "sample_contactphone": "416-555-0222",
        "sample_shippingpostalcode": "K1A 0B1",
        f"{NAV_ORDER_CUSTOMER}@odata.bind": f"/sample_customers({ensure('sample_customers','Initech',{})})",
    })
    ensure("sample_orderlines", "ORD-1002 / CRM License", {
        "sample_quantity": 5, "sample_lineamount": 6000,
        f"{NAV_LINE_ORDER}@odata.bind": f"/sample_orders({o2})",
        f"{NAV_LINE_PRODUCT}@odata.bind": f"/sample_products({crm})"})

    # ORD-1003 expedited + Fragile (Globex Retail); 1 line
    retail = ensure("sample_customers", "Globex Retail", {})
    o3 = ensure("sample_orders", "ORD-1003", {
        "sample_status": 1, "sample_isexpedited": True, "sample_ordertotal": 25,
        "sample_ordertags": "2",  # Fragile
        "sample_contactemail": "ops@globexretail.example", "sample_contactphone": "416-555-0111",
        "sample_shippingpostalcode": "M5V 2T7",
        f"{NAV_ORDER_CUSTOMER}@odata.bind": f"/sample_customers({retail})",
    })
    ensure("sample_orderlines", "ORD-1003 / Widget", {
        "sample_quantity": 1, "sample_lineamount": 25,
        f"{NAV_LINE_ORDER}@odata.bind": f"/sample_orders({o3})",
        f"{NAV_LINE_PRODUCT}@odata.bind": f"/sample_products({widget})"})

    # ORD-1004 zero lines (Globex) -> RowCount block
    ensure("sample_orders", "ORD-1004", {
        "sample_status": 1, "sample_isexpedited": False, "sample_ordertotal": 0,
        "sample_contactemail": "buyer@globex.example", "sample_contactphone": "416-555-0100",
        "sample_shippingpostalcode": "M5V 2T6",
        f"{NAV_ORDER_CUSTOMER}@odata.bind": f"/sample_customers({globex})",
    })

    print("\nDONE. seed data created.")


if __name__ == "__main__":
    main()
