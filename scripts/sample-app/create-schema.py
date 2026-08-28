"""Create the sample-app publisher, solution, tables, columns, and relationships.
Idempotent: checks for each component before creating. Run from repo root:
    python scripts/sample-app/create-schema.py

This is the complete fixture-schema provisioning script for a fresh org: it creates every
``sample_*`` table / column / lookup the live client suites (client/test-dev, client/test-e2e,
client/scripts/seed-*) depend on, including ``sample_shipment`` (the EXISTS sibling collection
under ``sample_order``) and ``sample_orderline.sample_notes`` (the pushdown-volume shape flag).
Column shapes mirror the reference environment exactly, so re-running on a provisioned org
prints ``[skip]`` for everything.

Target org: whatever ``DATAVERSE_URL`` is in the process environment — it overrides the .env
value (``load_env`` uses setdefault), so the script can be pointed at another org (e.g. the
Tier-C trial org) without editing .env:
    DATAVERSE_URL=https://<org>.crm3.dynamics.com/ python scripts/sample-app/create-schema.py

Everything lands in the ``RulesEngineSampleApp`` solution (publisher ``ascentixsample``, prefix
``sample``) — never in ``AscentixRulesEngine`` (fixture schema must not ship).
"""
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "sample-app"))
import _dv  # noqa: E402
from _dv import get as _get, post, patch, label, publish_all  # noqa: E402


def get(path):
    """Wrap _dv.get to percent-encode spaces in query strings (Python 3.13 urlopen is strict)."""
    if "?" in path:
        base_path, qs = path.split("?", 1)
        path = base_path + "?" + qs.replace(" ", "%20").replace("'", "%27")
    return _get(path)

PFX = "sample"


# ---- publisher + solution -------------------------------------------------

def ensure_publisher():
    existing = get("publishers?$select=publisherid,customizationprefix"
                   "&$filter=customizationprefix eq 'sample'")
    if existing["value"]:
        pid = existing["value"][0]["publisherid"]
        print(f"[skip] publisher (prefix sample) {pid}")
        return pid
    pid = post("publishers", {
        "uniquename": "ascentixsample",
        "friendlyname": "Ascentix Sample",
        "customizationprefix": "sample",
        "customizationoptionvalueprefix": 20000,
    }, solution=False)
    print(f"[create] publisher {pid}")
    return pid


def ensure_solution(pid):
    existing = get("solutions?$select=solutionid&$filter=uniquename eq 'RulesEngineSampleApp'")
    if existing["value"]:
        print("[skip] solution RulesEngineSampleApp")
        return existing["value"][0]["solutionid"]
    sid = post("solutions", {
        "uniquename": "RulesEngineSampleApp",
        "friendlyname": "Rules Engine Sample App",
        "version": "1.0.0.0",
        "publisherid@odata.bind": f"/publishers({pid})",
    }, solution=False)
    print(f"[create] solution {sid}")
    return sid


# ---- table + column helpers (Web API metadata) ----------------------------

def table_exists(logical):
    r = get(f"EntityDefinitions?$select=LogicalName&$filter=LogicalName eq '{logical}'")
    return bool(r["value"])


def attr_exists(table_logical, col_logical):
    r = get(f"EntityDefinitions(LogicalName='{table_logical}')/Attributes"
            f"?$select=LogicalName&$filter=LogicalName eq '{col_logical}'")
    return bool(r["value"])


def create_table(schema, display, plural, name_maxlen=200):
    """Create a user-owned table with a string primary name column sample_name.

    ``name_maxlen`` mirrors the existing DEV tables: 200 for the original four, 100 for
    ``sample_shipment`` (hand-provisioned). Match on logical name only — a
    pre-existing table with a different display name still counts as present.
    """
    logical = schema.lower()
    if table_exists(logical):
        print(f"[skip] table {logical}")
        return
    entity = {
        "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
        "SchemaName": schema,
        "DisplayName": label(display),
        "DisplayCollectionName": label(plural),
        "OwnershipType": "UserOwned",
        "HasActivities": False, "HasNotes": False, "IsActivity": False,
        "Attributes": [{
            "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
            "SchemaName": f"{PFX}_Name",
            "DisplayName": label("Name"),
            "RequiredLevel": {"Value": "ApplicationRequired"},
            "MaxLength": name_maxlen, "IsPrimaryName": True,
        }],
    }
    post("EntityDefinitions", entity)
    print(f"[create] table {logical}")


def _attr_path(table_logical):
    return f"EntityDefinitions(LogicalName='{table_logical}')/Attributes"


def add_string(table, col, disp, maxlen=200, fmt="Text"):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp),
        "RequiredLevel": {"Value": "None"}, "MaxLength": maxlen, "FormatName": {"Value": fmt},
    })
    print(f"[create] {table}.{logical} (string)")


def add_memo(table, col, disp, maxlen=2000):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.MemoAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp),
        "RequiredLevel": {"Value": "None"}, "MaxLength": maxlen,
    })
    print(f"[create] {table}.{logical} (memo)")


def add_money(table, col, disp):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.MoneyAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp),
        "RequiredLevel": {"Value": "None"}, "MinValue": 0, "MaxValue": 1000000000,
        "Precision": 2, "PrecisionSource": 2,
    })
    print(f"[create] {table}.{logical} (money)")


def add_int(table, col, disp):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp),
        "RequiredLevel": {"Value": "None"}, "MinValue": 0, "MaxValue": 1000000,
    })
    print(f"[create] {table}.{logical} (int)")


def add_bool(table, col, disp):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp), "RequiredLevel": {"Value": "None"},
        "OptionSet": {
            "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
            "TrueOption": {"Value": 1, "Label": label("Yes")},
            "FalseOption": {"Value": 0, "Label": label("No")},
        },
        "DefaultValue": False,
    })
    print(f"[create] {table}.{logical} (bool)")


def add_datetime(table, col, disp):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    post(_attr_path(table), {
        "@odata.type": "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
        "SchemaName": col, "DisplayName": label(disp), "RequiredLevel": {"Value": "None"},
        "Format": "DateOnly", "DateTimeBehavior": {"Value": "UserLocal"},
    })
    print(f"[create] {table}.{logical} (datetime)")


def _options(pairs):
    return [{"Value": v, "Label": label(t)} for v, t in pairs]


def add_choice(table, col, disp, pairs, multi=False):
    logical = col.lower()
    if attr_exists(table, logical):
        print(f"[skip] {table}.{logical}"); return
    odata = ("Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata" if multi
             else "Microsoft.Dynamics.CRM.PicklistAttributeMetadata")
    post(_attr_path(table), {
        "@odata.type": odata,
        "SchemaName": col, "DisplayName": label(disp), "RequiredLevel": {"Value": "None"},
        "OptionSet": {
            "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
            "IsGlobal": False, "OptionSetType": "Picklist",
            "Options": _options(pairs),
        },
    })
    print(f"[create] {table}.{logical} ({'multiselect' if multi else 'choice'})")


def add_lookup(referencing, referenced, col, disp, rel_schema):
    logical = col.lower()
    if attr_exists(referencing, logical):
        print(f"[skip] {referencing}.{logical}"); return
    post("RelationshipDefinitions", {
        "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
        "SchemaName": rel_schema,
        "ReferencedEntity": referenced, "ReferencingEntity": referencing,
        "Lookup": {
            "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
            "SchemaName": col, "DisplayName": label(disp), "RequiredLevel": {"Value": "None"},
        },
    })
    print(f"[create] lookup {referencing}.{logical} -> {referenced}")


def ensure_in_solution(table_logical):
    """Make sure the table (with all its subcomponents) is a component of RulesEngineSampleApp.

    Idempotent repair step: orgs provisioned before the MSCRM.SolutionUniqueName header fix
    (see _dv.py) got every table in the default solution only. AddSolutionComponent with
    DoNotIncludeSubcomponents=False pulls in the table's columns and relationships too.
    """
    sol = get("solutions?$select=solutionid&$filter=uniquename eq 'RulesEngineSampleApp'")["value"]
    sid = sol[0]["solutionid"]
    mid = get(f"EntityDefinitions(LogicalName='{table_logical}')?$select=MetadataId")["MetadataId"]
    comp = get(f"solutioncomponents?$select=solutioncomponentid&$filter=_solutionid_value eq {sid}"
               f" and componenttype eq 1 and objectid eq {mid}")
    if comp["value"]:
        print(f"[skip] {table_logical} in solution RulesEngineSampleApp"); return
    post("AddSolutionComponent", {
        "ComponentId": mid, "ComponentType": 1, "SolutionUniqueName": "RulesEngineSampleApp",
        "AddRequiredComponents": False, "DoNotIncludeSubcomponents": False,
    }, solution=False)
    print(f"[add] {table_logical} -> solution RulesEngineSampleApp")


def wait(label_text, secs=20):
    print(f"... waiting {secs}s for {label_text} to propagate")
    time.sleep(secs)


def main():
    pid = ensure_publisher()
    ensure_solution(pid)

    # Phase 1 — tables (each with sample_name primary)
    create_table("sample_Customer", "Customer", "Customers")
    create_table("sample_Product", "Product", "Products")
    create_table("sample_Order", "Order", "Orders")
    create_table("sample_OrderLine", "Order Line", "Order Lines")
    # EXISTS sibling collection under sample_order (second child alongside sample_orderline).
    create_table("sample_Shipment", "Shipment", "Shipments", name_maxlen=100)
    wait("tables")

    # Phase 2 — simple + typed columns
    # customer
    add_string("sample_customer", "sample_Email", "Email", fmt="Email")
    add_string("sample_customer", "sample_Phone", "Phone", fmt="Phone")
    add_string("sample_customer", "sample_PostalCode", "Postal Code", maxlen=20)
    add_money("sample_customer", "sample_CreditLimit", "Credit Limit")
    add_choice("sample_customer", "sample_Segments", "Segments",
               [(1, "Retail"), (2, "Wholesale"), (3, "VIP"), (4, "Government")], multi=True)
    # product
    add_money("sample_product", "sample_UnitPrice", "Unit Price")
    add_choice("sample_product", "sample_Category", "Category",
               [(1, "Hardware"), (2, "Software"), (3, "Service")])
    add_bool("sample_product", "sample_Discontinued", "Discontinued")
    # order
    add_money("sample_order", "sample_OrderTotal", "Order Total")
    add_choice("sample_order", "sample_Status", "Status",
               [(1, "Draft"), (2, "Submitted"), (3, "Approved"), (4, "Shipped"), (5, "Cancelled")])
    add_datetime("sample_order", "sample_OrderDate", "Order Date")
    add_bool("sample_order", "sample_IsExpedited", "Is Expedited")
    add_choice("sample_order", "sample_OrderTags", "Order Tags",
               [(1, "Gift"), (2, "Fragile"), (3, "Rush")], multi=True)
    add_string("sample_order", "sample_ContactEmail", "Contact Email", fmt="Email")
    add_string("sample_order", "sample_ContactPhone", "Contact Phone", fmt="Phone")
    add_string("sample_order", "sample_ShippingPostalCode", "Shipping Postal Code", maxlen=20)
    add_memo("sample_order", "sample_ApprovalNotes", "Approval Notes")
    add_memo("sample_order", "sample_HandlingInstructions", "Handling Instructions")
    # order line
    add_int("sample_orderline", "sample_Quantity", "Quantity")
    add_money("sample_orderline", "sample_LineAmount", "Line Amount")
    # Pushdown-volume shape flag (client/scripts/seed-volume-fixture.mjs writes "volA"/"volB").
    # SchemaName is deliberately lowercase — that is how DEV has it (String 200, Text).
    add_string("sample_orderline", "sample_notes", "Notes")
    # shipment
    add_bool("sample_shipment", "sample_IsExpedited", "Is Expedited")
    add_money("sample_shipment", "sample_ShipAmount", "Ship Amount")
    wait("columns")

    # Phase 3 — relationships / lookups
    add_lookup("sample_order", "sample_customer", "sample_CustomerId", "Customer",
               "sample_customer_sample_order")
    add_lookup("sample_customer", "sample_customer", "sample_ParentCustomerId", "Parent Customer",
               "sample_customer_sample_customer")
    add_lookup("sample_orderline", "sample_order", "sample_OrderId", "Order",
               "sample_order_sample_orderline")
    add_lookup("sample_orderline", "sample_product", "sample_ProductId", "Product",
               "sample_product_sample_orderline")
    add_lookup("sample_shipment", "sample_order", "sample_OrderId", "Order",
               "sample_order_sample_shipment")
    wait("relationships")

    # Phase 4 — solution membership (repairs orgs provisioned with the ignored header)
    for t in ("sample_customer", "sample_product", "sample_order", "sample_orderline", "sample_shipment"):
        ensure_in_solution(t)

    publish_all()
    print("\nDONE. schema created + published.")


if __name__ == "__main__":
    main()
