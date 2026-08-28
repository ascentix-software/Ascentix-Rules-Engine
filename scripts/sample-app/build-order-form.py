"""Customize the sample_order main form: add the order fields, hide the Handling
Instructions cell (so rule R2's SetVisible can reveal it), and add an Order Lines
subgrid. Idempotent (rebuilds the form's formxml deterministically). Run from repo
root after create-schema.py:  python scripts/sample-app/build-order-form.py
"""
import os
import sys
import uuid

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "sample-app"))
import _dv  # noqa: E402
from _dv import get, patch, post  # noqa: E402

ORDERLINE_VIEW = "db612cbc-f8b9-49b0-ad2a-24ac59bed7e7"   # "Active Order Lines"
ORDER_LINE_REL = "sample_order_sample_orderline"

# control classids by control kind
CID = {
    "text": "{4273EDBD-AC1D-40d3-9FB2-095C621B552D}",
    "lookup": "{270BD3DB-D9AF-4782-9025-509E298DEC0A}",
    "money": "{533B9E00-756B-4312-95A0-DC888637AC78}",
    "optionset": "{3EF39988-22BB-4f0b-BBBE-64B5A3748AEE}",
    "datetime": "{5B773807-9FB2-42db-97C3-7A91EFF8ADFF}",
    "boolean": "{67FAC785-CD58-4f9f-ABB3-4B7DDC6ED5ED}",
    "memo": "{E0DECE4B-6FC8-4a8f-A065-082708572369}",
    # MultiSelectPicklist. Read off the live sample_order form rather than guessed;
    # this control kind is not in the commonly-cited classid lists.
    "multiselect": "{4AA28AB7-9C13-4F57-A73D-AD894D048B5F}",
    "subgrid": "{E7A81278-8635-4d9e-8D4D-59480B391C5B}",
}

# (datafield, label, kind, visible) — order of appearance on the General section
FIELDS = [
    ("sample_name", "Name", "text", True),
    ("ownerid", "Owner", "lookup", True),
    ("sample_customerid", "Customer", "lookup", True),
    # DO NOT REMOVE. formLibraryDataTypes.e2e asserts recordJson.encode()'s multi-select branch
    # against a real Xrm attribute, and sample_ordertags is the only multi-select column on this
    # table. recordJson.ts drops off-form columns before encode() runs, so taking this off the
    # form silently deletes that coverage. (It was added to the form by hand and missing here
    # from this list for a while — the drift that motivated the stronger [verify] step below.)
    ("sample_ordertags", "Order Tags", "multiselect", True),
    ("sample_ordertotal", "Order Total", "money", True),
    ("sample_status", "Status", "optionset", True),
    ("sample_orderdate", "Order Date", "datetime", True),
    ("sample_isexpedited", "Is Expedited", "boolean", True),
    ("sample_contactemail", "Contact Email", "text", True),
    ("sample_contactphone", "Contact Phone", "text", True),
    ("sample_shippingpostalcode", "Shipping Postal Code", "text", True),
    ("sample_approvalnotes", "Approval Notes", "memo", True),
    ("sample_handlinginstructions", "Handling Instructions", "memo", False),  # hidden; R2 reveals it
]


def guid():
    return "{" + str(uuid.uuid4()).upper() + "}"


def field_row(datafield, label, kind, visible):
    vis = "" if visible else ' visible="false"'
    # ownerid keeps its standard control id; others use the datafield as the control id
    ctrl_id = datafield
    return (
        f'<row><cell id="{guid()}"{vis}>'
        f'<labels><label description="{label}" languagecode="1033" /></labels>'
        f'<control id="{ctrl_id}" classid="{CID[kind]}" datafieldname="{datafield}" />'
        f"</cell></row>"
    )


def subgrid_section():
    cell_id = guid()
    return (
        f'<section showlabel="true" showbar="true" IsUserDefined="0" id="{guid()}">'
        f'<labels><label description="Order Lines" languagecode="1033" /></labels>'
        f'<rows><row><cell id="{cell_id}" showlabel="true" rowspan="6" colspan="1" auto="false">'
        f'<labels><label description="Order Lines" languagecode="1033" /></labels>'
        f'<control id="OrderLinesSubgrid" classid="{CID["subgrid"]}">'
        f"<parameters>"
        f"<ViewId>{ORDERLINE_VIEW.upper()}</ViewId>"
        f"<IsUserView>false</IsUserView>"
        f"<RelationshipName>{ORDER_LINE_REL}</RelationshipName>"
        f"<TargetEntityType>sample_orderline</TargetEntityType>"
        f"<AutoExpand>Fixed</AutoExpand>"
        f"<RecordsPerPage>10</RecordsPerPage>"
        f"<EnableQuickFind>false</EnableQuickFind>"
        f"<EnableJumpBar>false</EnableJumpBar>"
        f"<EnableViewPicker>false</EnableViewPicker>"
        f"<ViewIds />"
        f"<ChartGridMode>Grid</ChartGridMode>"
        f"</parameters></control></cell></row></rows></section>"
    )


def build_formxml():
    general_rows = "".join(field_row(*f) for f in FIELDS)
    general = (
        f'<section showlabel="false" showbar="false" IsUserDefined="0" id="{guid()}">'
        f'<labels><label description="General" languagecode="1033" /></labels>'
        f"<rows>{general_rows}</rows></section>"
    )
    return (
        f'<form><tabs><tab verticallayout="true" id="{guid()}" IsUserDefined="1">'
        f'<labels><label description="General" languagecode="1033" /></labels>'
        f'<columns><column width="100%"><sections>{general}{subgrid_section()}'
        f"</sections></column></columns></tab></tabs>"
        f"{form_libraries()}{events()}</form>"
    )


# ---- client form library registration --------------------------------------------------------
#
# THIS MUST BE EMITTED. build_formxml() rebuilds the form from scratch and PATCHes the whole
# thing, so anything this script does not generate is DESTROYED. These two
# functions once did not exist: the rules-engine web resource had been wired onto the form by hand,
# and the first run of this script after that silently unregistered it. The form still looked
# correct -- every control present, every label right -- and every rule-dependent e2e spec went
# red at once, because no rules were being applied at all.
#
# Contract is docs/Client-Form-Library.md section 3.3: add the web resource as a form library and
# register exactly ONE OnLoad handler, with the execution context passed. The library registers
# its own OnChange handlers at runtime from inside onLoad, and registers no OnSave handler.
LIBRARY = "$webresource:asx_/rulesengine/asx_rulesengine.js"
ONLOAD_FN = "Ascentix.RulesEngine.onLoad"


def form_libraries():
    return f'<formLibraries><Library name="{LIBRARY}" libraryUniqueId="{guid()}" /></formLibraries>'


def events():
    return (
        '<events><event name="onload" application="false" active="false">'
        "<InternalHandlers />"
        f'<Handlers><Handler functionName="{ONLOAD_FN}" libraryName="{LIBRARY}" '
        f'handlerUniqueId="{guid()}" enabled="true" parameters="" passExecutionContext="true" />'
        "</Handlers></event></events>"
    )


def main():
    flt = _dv.urllib.parse.quote("objecttypecode eq 'sample_order' and type eq 2")
    forms = get(f"systemforms?$select=formid,name&$filter={flt}")["value"]
    if not forms:
        raise SystemExit("No main form found for sample_order. Run create-schema first.")
    fid = forms[0]["formid"]

    patch(f"systemforms({fid})", {"formxml": build_formxml()}, solution=False)
    print(f"[patch] sample_order main form {fid}")

    post("PublishXml", {
        "ParameterXml": "<importexportxml><entities><entity>sample_order</entity></entities></importexportxml>",
    }, solution=False)
    print("[publish] sample_order")

    # verify round-trip
    xml = get(f"systemforms({fid})?$select=formxml")["formxml"]
    # Check EVERY datafield in FIELDS, not a hand-picked few. The old three-name check passed
    # happily while the live form carried a field this script did not know about — drift the
    # suite only noticed when a test that depended on the column's ABSENCE failed.
    checks = ([df for df, _lbl, _kind, _vis in FIELDS]
              + ["OrderLinesSubgrid", 'visible="false"']
              # The form library and its OnLoad handler. Without these the bundle never loads and
              # no rule is ever applied, while the form itself still looks perfectly correct --
              # which is exactly how this went unnoticed once already.
              + ["asx_rulesengine.js", ONLOAD_FN, 'passExecutionContext="true"'])
    missing = [c for c in checks if c not in xml]
    print("[verify] formxml length", len(xml), "| missing:", missing or "none")
    if missing:
        raise SystemExit(f"Form round-trip missing: {missing}")
    print("\nDONE. order form customized.")


if __name__ == "__main__":
    main()
