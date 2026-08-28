"""Author the sample asx_tableconfig node graph + six asx_ rules (idempotent by name).
Rules are DATA in the engine's asx_* config tables, referencing sample_ columns.
Run from repo root after create-schema.py:  python scripts/sample-app/author-rules.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "sample-app"))
import _dv  # noqa: E402
from _dv import get, post, resolve_nav_property  # noqa: E402

PUBLISHED = 753840000
TRIG_ONFORM_CREATE_UPDATE = "2,1,4"  # OnForm, OnCreate, OnUpdate

# nav properties on asx_ child tables (resolved from metadata)
NAV_CG_RULE = resolve_nav_property("asx_conditiongroup", "asx_rule", "asx_rule")
NAV_COND_CG = resolve_nav_property("asx_rulecondition", "asx_conditiongroup", "asx_conditiongroup")
NAV_COND_TC = resolve_nav_property("asx_rulecondition", "asx_tableconfig", "asx_tableconfig")
NAV_COND_VALNODE = resolve_nav_property("asx_rulecondition", "asx_tableconfig", "asx_comparisonvaluenode")
NAV_ACTION_RULE = resolve_nav_property("asx_ruleaction", "asx_rule", "asx_rule")
NAV_TC_PARENT = resolve_nav_property("asx_tableconfig", "asx_tableconfig", "asx_parenttable")


def ensure(entityset, name, payload):
    flt = _dv.urllib.parse.quote(f"asx_name eq '{name}'")
    existing = get(f"{entityset}?$filter={flt}")
    if existing["value"]:
        rec = existing["value"][0]
        idkey = next(k for k in rec if k.endswith("id") and k.startswith("asx_"))
        print(f"[skip] {entityset} '{name}'")
        return rec[idkey]
    rid = post(entityset, {"asx_name": name, **payload})
    print(f"[create] {entityset} '{name}' {rid}")
    return rid


# ---- table-config node graph (rooted at sample_order) ----------------------

def build_tableconfig():
    order = ensure("asx_tableconfigs", "SAMPLE Order (root)", {
        "asx_tablelogicalname": "sample_order", "asx_tableconfigtype": 1})
    customer = ensure("asx_tableconfigs", "SAMPLE Customer (lookup)", {
        "asx_tablelogicalname": "sample_customer", "asx_tableconfigtype": 2,
        "asx_lookupcolumnlogicalname": "sample_customerid",
        f"{NAV_TC_PARENT}@odata.bind": f"/asx_tableconfigs({order})"})
    parent = ensure("asx_tableconfigs", "SAMPLE Parent Customer (lookup)", {
        "asx_tablelogicalname": "sample_customer", "asx_tableconfigtype": 2,
        "asx_lookupcolumnlogicalname": "sample_parentcustomerid",
        f"{NAV_TC_PARENT}@odata.bind": f"/asx_tableconfigs({customer})"})
    line = ensure("asx_tableconfigs", "SAMPLE Order Line (child)", {
        "asx_tablelogicalname": "sample_orderline", "asx_tableconfigtype": 3,
        "asx_childlinkfield": "sample_orderid",
        f"{NAV_TC_PARENT}@odata.bind": f"/asx_tableconfigs({order})"})
    product = ensure("asx_tableconfigs", "SAMPLE Product (lookup)", {
        "asx_tablelogicalname": "sample_product", "asx_tableconfigtype": 2,
        "asx_lookupcolumnlogicalname": "sample_productid",
        f"{NAV_TC_PARENT}@odata.bind": f"/asx_tableconfigs({line})"})
    return {"order": order, "customer": customer, "parent": parent, "line": line, "product": product}


def rule(name, severity=None):
    payload = {"asx_tablelogicalname": "sample_order", "statuscode": PUBLISHED,
               "asx_triggers": TRIG_ONFORM_CREATE_UPDATE}
    if severity:
        payload["asx_severity"] = severity
    return ensure("asx_rules", name, payload)


def group(name, rule_id, op=1, is_exec=False):
    return ensure("asx_conditiongroups", name, {
        "asx_logicaloperator": op, "asx_isexecutioncondition": is_exec,
        f"{NAV_CG_RULE}@odata.bind": f"/asx_rules({rule_id})"})


def condition(name, cg_id, tc_id, **extra):
    payload = {f"{NAV_COND_CG}@odata.bind": f"/asx_conditiongroups({cg_id})",
               f"{NAV_COND_TC}@odata.bind": f"/asx_tableconfigs({tc_id})"}
    payload.update(extra)
    return ensure("asx_ruleconditions", name, payload)


def action(name, rule_id, **extra):
    return ensure("asx_ruleactions", name, {
        f"{NAV_ACTION_RULE}@odata.bind": f"/asx_rules({rule_id})", "asx_order": 1,
        "asx_isactive": True, **extra})


def main():
    tc = build_tableconfig()

    # R1 — expedited -> require approval notes (root FieldComparison bool, SetRequired)
    r1 = rule("SAMPLE R1 Expedited requires approval notes")
    g1 = group("SAMPLE R1 group", r1)
    condition("SAMPLE R1 cond", g1, tc["order"], asx_conditiontype=1,
              asx_comparisoncolumn="sample_isexpedited", asx_comparisonoperator=1,
              asx_comparisonvalue="1", asx_comparisonvaluesource=1)
    action("SAMPLE R1 action", r1, asx_actiontype=2, asx_fireon=1,
           asx_targetcolumn="sample_approvalnotes", asx_valuebool=True,
           asx_applyinversewhennotfired=True)

    # R2 — tags contains Fragile -> reveal handling instructions (root multiselect, SetVisible)
    r2 = rule("SAMPLE R2 Fragile reveals handling")
    g2 = group("SAMPLE R2 group", r2)
    condition("SAMPLE R2 cond", g2, tc["order"], asx_conditiontype=1,
              asx_comparisoncolumn="sample_ordertags", asx_comparisonoperator=7,  # Contains
              asx_comparisonvalue="2", asx_comparisonvaluesource=1)  # Fragile=2
    action("SAMPLE R2 action", r2, asx_actiontype=1, asx_fireon=1,
           asx_targetcolumn="sample_handlinginstructions", asx_valuebool=True,
           asx_applyinversewhennotfired=True)

    # R3 — contact email must be valid (root EmailAddress validator, Block)
    r3 = rule("SAMPLE R3 Contact email valid", severity=3)
    g3 = group("SAMPLE R3 group", r3)
    condition("SAMPLE R3 cond", g3, tc["order"], asx_conditiontype=4,  # EmailAddress
              asx_comparisoncolumn="sample_contactemail", asx_comparisonvaluesource=1)
    action("SAMPLE R3 action", r3, asx_actiontype=4, asx_fireon=2,  # Block OnNoMatch
           asx_targetcolumn="sample_contactemail",  # surfaces inline on the field
           asx_message="Contact email is not a valid email address.", asx_severity=3)

    # R4 — order must have >=1 line (RowCount on child, Block)
    r4 = rule("SAMPLE R4 Order needs a line", severity=3)
    g4 = group("SAMPLE R4 group", r4)
    condition("SAMPLE R4 cond", g4, tc["line"], asx_conditiontype=2,  # RowCount
              asx_minexpectedrows=1, asx_comparisonvaluesource=1)
    action("SAMPLE R4 action", r4, asx_actiontype=4, asx_fireon=2,
           asx_message="An order must have at least one order line.", asx_severity=3)

    # R5 — total <= customer credit limit (FieldReference to lookup node, Block)
    r5 = rule("SAMPLE R5 Total within credit limit", severity=3)
    g5 = group("SAMPLE R5 group", r5)
    condition("SAMPLE R5 cond", g5, tc["order"], asx_conditiontype=1,
              asx_comparisoncolumn="sample_ordertotal", asx_comparisonoperator=6,  # LessThanOrEqual
              asx_comparisonvaluesource=2,  # FieldReference
              asx_comparisonvaluecolumn="sample_creditlimit",
              **{f"{NAV_COND_VALNODE}@odata.bind": f"/asx_tableconfigs({tc['customer']})"})
    action("SAMPLE R5 action", r5, asx_actiontype=4, asx_fireon=2,
           asx_targetcolumn="sample_ordertotal",  # surfaces inline on the field
           asx_message="Order total exceeds the customer credit limit.", asx_severity=3)

    # R6 — customer OR parent segment includes VIP -> banner (multi-level lookup, OR group, ShowMessage)
    r6 = rule("SAMPLE R6 VIP banner")
    g6 = group("SAMPLE R6 group (OR)", r6, op=2)  # Or
    condition("SAMPLE R6 cond customer", g6, tc["customer"], asx_conditiontype=1,
              asx_comparisoncolumn="sample_segments", asx_comparisonoperator=7,  # Contains
              asx_comparisonvalue="3", asx_comparisonvaluesource=1)  # VIP=3
    condition("SAMPLE R6 cond parent", g6, tc["parent"], asx_conditiontype=1,
              asx_comparisoncolumn="sample_segments", asx_comparisonoperator=7,
              asx_comparisonvalue="3", asx_comparisonvaluesource=1)
    action("SAMPLE R6 action", r6, asx_actiontype=3, asx_fireon=1,  # ShowMessage OnMatch
           asx_message="VIP customer — apply white-glove handling.", asx_severity=1)

    print("\nDONE. six rules + tableconfig graph authored.")


if __name__ == "__main__":
    main()
