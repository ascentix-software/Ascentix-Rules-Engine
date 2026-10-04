"""Perf volume generator: seeds lookup pool, perf_root rows, child fan-out, and asx_rule records.

All generated names are PERF-namespaced. Deterministic via --seed.
Bulk creates via the Web API $batch endpoint (chunked at BATCH_SIZE per request).
Every seeded row (lookup pool, roots, children) also gets a perf_date 0-60 days before today
(profiles.date_value), drawn from its own random stream.

Rules are created as Draft (no statuscode on create) and published one at a time afterward with a
statuscode-only PATCH (see publish_rules) — exactly how the Rule Builder publishes. The
RuleRevisionGuardPlugin refuses creating an asx_rule directly as Published ("Create and save a
draft before publishing it."), and publishing this way also registers the RulesEnginePlugin steps
a save needs, so the seeded rules enforce real perf_root saves.

--rows-per-root N seeds exactly N perf_child1 rows per root (flat; categories cycling
30001/30002/30003) and no child2/child3, overriding --child-fanout.

--profile S1..S6 adds that scenario's rule shapes (profiles.rule_specs; --profile-step sets S5's
schedule count and S6's table count) on top of the background rules, whose default count then
comes from profiles.DEFAULT_BACKGROUND. S2/S3 downgrade background Blocks to Show Message; S4/S5
skip the self-reference wiring. S5's schedules are created after publishing.

Run from repo root:
    python scripts/perf/generate.py
    python scripts/perf/generate.py --records 5 --child-fanout 3 --rules 20
    python scripts/perf/generate.py --records 25 --rows-per-root 12 --rules 20
    python scripts/perf/generate.py --records 25 --rows-per-root 100 --profile S1
    python scripts/perf/generate.py --records 1000 --rows-per-root 1 --profile S5 --profile-step 10

Option values used (PUBLISHED here, the rest in profiles.py; sources cited):
  PUBLISHED        = 753840000 — author-rules.py line 12, confirmed docs/Schema.md s2.1
  TRIG_ON_UPDATE   = "4"       — docs/Schema.md s1 (On Update = 4); harness passes Triggers="OnUpdate"
  COND_FIELD       = 1         — docs/Schema.md s1 (Field Comparison = 1); author-rules.py line 94
  COND_ROWCOUNT    = 2         — docs/Schema.md s1 (Row Count = 2); author-rules.py line 123
  OP_EQUALS        = 1         — docs/Schema.md s1 (Equals = 1); author-rules.py line 96
  OP_NOT_EQUALS    = 2         — docs/Schema.md s1 (Not Equals = 2)
  OP_GT            = 3         — docs/Schema.md s1 (Greater Than = 3)
  OP_GTE           = 4         — docs/Schema.md s1 (Greater Than Or Equal = 4)
  OP_LT            = 5         — docs/Schema.md s1 (Less Than = 5)
  OP_LTE           = 6         — docs/Schema.md s1 (Less Than Or Equal = 6)
  OP_CONTAINS      = 7         — docs/Schema.md s1 (Contains = 7)
  OP_NOT_CONTAINS  = 8         — docs/Schema.md s1 (Does Not Contain = 8)
  OP_IS_NULL       = 9         — docs/Schema.md s1 (Is Null = 9)
  OP_IS_NOT_NULL   = 10        — docs/Schema.md s1 (Is Not Null = 10)
  SRC_LITERAL      = 1         — docs/Schema.md s1 (Literal = 1); author-rules.py line 96
  SRC_FIELDREF     = 2         — docs/Schema.md s1 (Field Reference = 2); author-rules.py line 133
  LOG_AND          = 1         — docs/Schema.md s1 (And = 1); author-rules.py line 69
  LOG_OR           = 2         — docs/Schema.md s1 (Or = 2); author-rules.py line 142
  ACT_SHOWMSG      = 3         — docs/Schema.md s1 (Show Message = 3); author-rules.py line 149
  ACT_BLOCK        = 4         — docs/Schema.md s1 (Block = 4); author-rules.py line 116
  FIREON_MATCH     = 1         — docs/Schema.md s1 (On Match = 1); author-rules.py line 97
  FIREON_NOMATCH   = 2         — docs/Schema.md s1 (On No Match = 2); author-rules.py line 116
  CATEGORY values  = 30001, 30002, 30003 — create-schema.py line 231 (Option A/B/C)

Operator pools per column type (ConditionEvaluator.cs authoritative):
  NUMERIC_OPS  — Equals, NotEquals, GreaterThan, GreaterThanOrEqual, LessThan, LessThanOrEqual
  STRING_OPS   — Equals, NotEquals, Contains, DoesNotContain, IsNull, IsNotNull
  BOOL_OPS     — Equals, NotEquals  (compare to literal "1"/"0")
  CHOICE_OPS   — Equals, NotEquals  (compare to int option value as string)
  perf_date    — not used by the background rules; the S1/S6 profiles compare it with date
                 expressions (asx_comparisonvaluesource 4)
  IsNull/IsNotNull conditions omit asx_comparisonvalue entirely (no value needed).
"""
import argparse
import datetime
import json
import os
import random
import sys
import uuid
import urllib.error
import urllib.parse

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "perf"))
import _dv  # noqa: E402
from _dv import get, post  # noqa: E402
import profiles  # noqa: E402
# Option-set values live in profiles.py, the single home of the harness's shared constants.
from profiles import (  # noqa: E402
    TRIG_ON_UPDATE, COND_FIELD, COND_ROWCOUNT,
    OP_EQUALS, OP_NOT_EQUALS, OP_CONTAINS, OP_NOT_CONTAINS, OP_IS_NULL, OP_IS_NOT_NULL,
    SRC_LITERAL, SRC_FIELDREF, LOG_AND, LOG_OR, FIREON_MATCH, FIREON_NOMATCH,
)

# ---------------------------------------------------------------------------
# Option-set constants — sourced from author-rules.py and docs/Schema.md
# ---------------------------------------------------------------------------

# author-rules.py line 12: PUBLISHED = 753840000
PUBLISHED = 753840000

# Operator pools keyed by column type — ConditionEvaluator.cs is authoritative.
# The engine picks numeric-vs-string comparison AT RUNTIME: it uses the numeric path only
# when BOTH operands parse as decimal (ConditionEvaluator.EvaluateComparison), else the string
# path — which THROWS on ordering operators (GT/GTE/LT/LTE). With generated data and field-ref
# RHS operands, an operand can be null/non-numeric at runtime, so ordering ops are unsafe to emit
# at all. Traversal cost (what this fixture profiles) is incurred regardless of whether a
# condition matches, so we omit ordering ops entirely and use only operators safe in both paths.
# perf_date is excluded from the background field-comparison conditions (the S1/S6 profiles cover dates).
NUMERIC_OPS = [OP_EQUALS, OP_NOT_EQUALS]
STRING_OPS  = [OP_EQUALS, OP_NOT_EQUALS, OP_CONTAINS, OP_NOT_CONTAINS, OP_IS_NULL, OP_IS_NOT_NULL]
BOOL_OPS    = [OP_EQUALS, OP_NOT_EQUALS]
CHOICE_OPS  = [OP_EQUALS, OP_NOT_EQUALS]

# asx_actiontype (profiles.ACT_SHOWMSG=3, profiles.ACT_BLOCK=4) and perf_category option values
# (profiles.CATEGORY_OPTIONS = [30001, 30002, 30003], create-schema.py line 231) also live in
# profiles.py.

# perf typed columns (from create-schema.py add_typed_columns)
TYPED_COLS = {
    "text":     "perf_text",
    "number":   "perf_number",
    "amount":   "perf_amount",
    "flag":     "perf_flag",
    "category": "perf_category",
    "date":     "perf_date",
}

# Batch chunk size for $batch
BATCH_SIZE = 100

# ---------------------------------------------------------------------------
# Nav properties (resolved once at startup from Dataverse metadata)
# ---------------------------------------------------------------------------

def resolve_nav(entity, ref_entity, ref_attr):
    """Wrapper around _dv.resolve_nav_property for clarity."""
    return _dv.resolve_nav_property(entity, ref_entity, ref_attr)


_NAV_CACHE = {}


def nav(entity, ref_entity, ref_attr):
    key = (entity, ref_entity, ref_attr)
    if key not in _NAV_CACHE:
        _NAV_CACHE[key] = resolve_nav(entity, ref_entity, ref_attr)
    return _NAV_CACHE[key]


# ---------------------------------------------------------------------------
# $batch helper
# ---------------------------------------------------------------------------

def batch_post(requests_list):
    """Send a $batch request. requests_list is a list of (entity_set, payload) tuples.
    Returns list of created GUIDs (extracted from Content-ID response headers or Location).
    """
    boundary = f"batch_{uuid.uuid4().hex}"
    lines = [f"--{boundary}"]
    for i, (entity_set, payload) in enumerate(requests_list):
        content_id = str(i + 1)
        lines.append("Content-Type: application/http")
        lines.append("Content-Transfer-Encoding: binary")
        lines.append(f"Content-ID: {content_id}")
        lines.append("")
        lines.append(f"POST {_dv.BASE}/{entity_set} HTTP/1.1")
        lines.append("Content-Type: application/json; charset=utf-8")
        lines.append("OData-MaxVersion: 4.0")
        lines.append("OData-Version: 4.0")
        lines.append("")
        lines.append(json.dumps(payload))
        lines.append(f"--{boundary}")
    # Close boundary
    lines[-1] = f"--{boundary}--"
    # Trailing CRLF after the closing boundary is required — without it the final
    # part's body stream is unterminated and Dataverse 400s ("Stream was not readable").
    body = ("\r\n".join(lines) + "\r\n").encode("utf-8")

    # _dv.send retries once with a fresh token on 401: a 50,000-root load outlives a token.
    try:
        _, raw = _dv.send("POST", f"{_dv.BASE}/$batch", body, write=True, solution=True,
                          content_type=f"multipart/mixed; boundary={boundary}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        raise SystemExit(f"ERROR $batch: {e.code}\n{detail}")

    # Parse GUIDs from Location headers in the multipart response
    guids = []
    for line in raw.splitlines():
        line = line.strip()
        if line.lower().startswith("odata-entityid:"):
            loc = line.split(":", 1)[1].strip()
            if "(" in loc:
                guids.append(loc.split("(")[-1].rstrip(")"))
    return guids


def _name_field(entity_set):
    return "asx_name" if entity_set.startswith("asx_") else "perf_name"


def _recover_chunk(entity_set, chunk):
    """After a dropped connection the server may have created none, some or all of a chunk's rows ($batch
    without a changeset commits each part on its own). Finds the chunk's rows by their unique names, creates
    only the missing ones, and returns every id in request order, so children still bind to the right parent.
    A chunk whose rows have no unique name can't be matched, so it stops rather than risk duplicates."""
    field = _name_field(entity_set)
    names = [p.get(field) for p in chunk]
    if any(n is None for n in names) or len(set(names)) != len(names):
        raise SystemExit(f"ERROR: the connection dropped creating {entity_set} rows with no {field} to "
                         "match them by; run reset-data.py and generate again.")
    id_field = entity_set[:-1] + "id"
    in_names = ",".join("'" + n.replace("'", "''") + "'" for n in names)
    flt = urllib.parse.quote(f"Microsoft.Dynamics.CRM.In(PropertyName='{field}',PropertyValues=[{in_names}])")
    found = {r[field]: r[id_field] for r in get(f"{entity_set}?$select={id_field},{field}&$filter={flt}")["value"]}
    missing = [p for p, n in zip(chunk, names) if n not in found]
    print(f"  connection dropped: {len(chunk) - len(missing)} of {len(chunk)} already created; creating the rest")
    if missing:
        guids = batch_post([(entity_set, p) for p in missing])
        if len(guids) != len(missing):
            raise SystemExit(f"ERROR: recovering {entity_set}: {len(guids)} id(s) for {len(missing)} rows")
        found.update(zip((p[field] for p in missing), guids))
    return [found[n] for n in names]


def bulk_create(entity_set, payloads, label="records"):
    """Bulk-create records in BATCH_SIZE chunks. Returns list of created GUIDs. A chunk lost to a dropped
    connection is recovered by name (_recover_chunk)."""
    all_guids = []
    chunks = [payloads[i:i + BATCH_SIZE] for i in range(0, len(payloads), BATCH_SIZE)]
    for ci, chunk in enumerate(chunks):
        print(f"  $batch chunk {ci + 1}/{len(chunks)} ({len(chunk)} {label})...")
        requests_list = [(entity_set, p) for p in chunk]
        try:
            guids = batch_post(requests_list)
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            guids = _recover_chunk(entity_set, chunk)
        if len(guids) != len(chunk):
            # Counts must match 1:1 in request order — children bind to parents by
            # index, so a partial result would scramble FK wiring. Fail loudly rather
            # than blindly re-POST (which would duplicate the rows already created).
            raise SystemExit(
                f"ERROR: $batch returned {len(guids)} OData-EntityId(s) for {len(chunk)} "
                f"{label} requests in chunk {ci + 1}. Aborting to avoid duplicate/misbound rows."
            )
        all_guids.extend(guids)
    return all_guids


# ---------------------------------------------------------------------------
# TableConfig lookup
# ---------------------------------------------------------------------------

def resolve_tableconfig_ids():
    """Fetch all PERF tableconfig nodes and return name->guid dict."""
    result = get("asx_tableconfigs?$select=asx_tableconfigid,asx_name"
                 "&$filter=startswith(asx_name,'PERF%20')")
    mapping = {}
    for rec in result.get("value", []):
        mapping[rec["asx_name"]] = rec["asx_tableconfigid"]
    required = [
        "PERF Root", "PERF L1", "PERF L2", "PERF L3", "PERF Self",
        "PERF Sib1", "PERF Sib2", "PERF Sib3", "PERF Sib4", "PERF Sib5", "PERF Sib6",
        "PERF Child1", "PERF Child2", "PERF Child3", "PERF Child1 Lookup",
    ]
    missing = [n for n in required if n not in mapping]
    if missing:
        raise SystemExit(
            f"Missing tableconfig nodes (run author-config.py first): {missing}"
        )
    return mapping


# ---------------------------------------------------------------------------
# Lookup pool seeding
# ---------------------------------------------------------------------------

def seed_lookup_pool(rng, dates, pool_size=20):
    """Create shared lookup pools for L3, L2, L1. Returns {l3: [...guids], l2: [...], l1: [...]}."""
    print(f"\n[1/5] Seeding lookup pool (size {pool_size} each)...")

    # L3 records
    l3_payloads = []
    for i in range(pool_size):
        l3_payloads.append({
            "perf_name": f"PERF-L3-{i:04d}",
            "perf_text":   f"l3text{i}",
            "perf_number": rng.randint(0, 1000),
            "perf_amount": round(rng.uniform(0.0, 5000.0), 2),
            "perf_flag":   rng.choice([True, False]),
            "perf_category": rng.choice(profiles.CATEGORY_OPTIONS),
            "perf_date":   dates(),
        })
    l3_guids = bulk_create("perf_lookup3s", l3_payloads, "L3")
    print(f"  L3 pool: {len(l3_guids)} records")

    # L2 records (each points at a random L3)
    nav_l2_l3 = nav("perf_lookup2", "perf_lookup3", "perf_lookup3id")
    l2_payloads = []
    for i in range(pool_size):
        l3_id = rng.choice(l3_guids)
        l2_payloads.append({
            "perf_name": f"PERF-L2-{i:04d}",
            "perf_text":   f"l2text{i}",
            "perf_number": rng.randint(0, 1000),
            "perf_amount": round(rng.uniform(0.0, 5000.0), 2),
            "perf_flag":   rng.choice([True, False]),
            "perf_category": rng.choice(profiles.CATEGORY_OPTIONS),
            "perf_date":   dates(),
            f"{nav_l2_l3}@odata.bind": f"/perf_lookup3s({l3_id})",
        })
    l2_guids = bulk_create("perf_lookup2s", l2_payloads, "L2")
    print(f"  L2 pool: {len(l2_guids)} records")

    # L1 records (each points at a random L2)
    nav_l1_l2 = nav("perf_lookup1", "perf_lookup2", "perf_lookup2id")
    l1_payloads = []
    for i in range(pool_size):
        l2_id = rng.choice(l2_guids)
        l1_payloads.append({
            "perf_name": f"PERF-L1-{i:04d}",
            "perf_text":   f"l1text{i}",
            "perf_number": rng.randint(0, 1000),
            "perf_amount": round(rng.uniform(0.0, 5000.0), 2),
            "perf_flag":   rng.choice([True, False]),
            "perf_category": rng.choice(profiles.CATEGORY_OPTIONS),
            "perf_date":   dates(),
            f"{nav_l1_l2}@odata.bind": f"/perf_lookup2s({l2_id})",
        })
    l1_guids = bulk_create("perf_lookup1s", l1_payloads, "L1")
    print(f"  L1 pool: {len(l1_guids)} records")

    return {"l1": l1_guids, "l2": l2_guids, "l3": l3_guids}


# ---------------------------------------------------------------------------
# perf_root + children seeding
# ---------------------------------------------------------------------------

def seed_roots(rng, dates, records, pool, lookup_breadth, patch_self_refs=True):
    """Create perf_root records. Returns list of root GUIDs."""
    print(f"\n[2/5] Seeding {records} perf_root records...")
    nav_root_l1    = nav("perf_root", "perf_lookup1", "perf_lookup1id")
    nav_root_self  = nav("perf_root", "perf_root",    "perf_parentrootid")
    nav_root_sib1  = nav("perf_root", "perf_lookup1", "perf_siblookup1")
    nav_root_sib2  = nav("perf_root", "perf_lookup1", "perf_siblookup2")
    nav_root_sib3  = nav("perf_root", "perf_lookup1", "perf_siblookup3")
    nav_root_sib4  = nav("perf_root", "perf_lookup1", "perf_siblookup4")
    nav_root_sib5  = nav("perf_root", "perf_lookup1", "perf_siblookup5")
    nav_root_sib6  = nav("perf_root", "perf_lookup1", "perf_siblookup6")

    # We need to create roots first without parent self-ref, then patch them.
    # To keep it simple: create all roots without perf_parentrootid first,
    # then patch a random subset to point at another root.
    sib_navs = [nav_root_sib1, nav_root_sib2, nav_root_sib3,
                nav_root_sib4, nav_root_sib5, nav_root_sib6]

    root_payloads = []
    for i in range(records):
        l1_id = rng.choice(pool["l1"])
        p = {
            "perf_name":     f"PERF-ROOT-{i:04d}",
            "perf_text":     f"roottext{i}",
            "perf_number":   rng.randint(0, 10000),
            "perf_amount":   round(rng.uniform(0.0, 100000.0), 2),
            "perf_flag":     rng.choice([True, False]),
            "perf_category": rng.choice(profiles.CATEGORY_OPTIONS),
            "perf_date":     dates(),
            f"{nav_root_l1}@odata.bind": f"/perf_lookup1s({l1_id})",
        }
        # Sibling lookups up to lookup_breadth (max 6)
        n_sibs = min(lookup_breadth, 6)
        for si in range(n_sibs):
            sib_id = rng.choice(pool["l1"])
            p[f"{sib_navs[si]}@odata.bind"] = f"/perf_lookup1s({sib_id})"
        root_payloads.append(p)

    root_guids = bulk_create("perf_roots", root_payloads, "roots")
    print(f"  Roots created: {len(root_guids)}")

    # Patch ~50% to have a perf_parentrootid self-ref. Skipped for large volumes (S4/S5 seed up
    # to 50,000 roots; patching half of them one PATCH at a time would take hours, and their
    # rules never read PERF Self).
    if patch_self_refs and len(root_guids) > 1:
        patch_count = max(1, len(root_guids) // 2)
        targets = rng.sample(root_guids, patch_count)
        print(f"  Patching {patch_count} roots with perf_parentrootid self-ref...")
        for gid in targets:
            parent_id = rng.choice([g for g in root_guids if g != gid])
            patch_payload = {f"{nav_root_self}@odata.bind": f"/perf_roots({parent_id})"}
            _dv.patch(f"perf_roots({gid})", patch_payload)

    return root_guids


def seed_children(rng, dates, root_guids, pool, child_fanout):
    """Create child1/2/3 records with multiplicative fan-out."""
    nav_c1_root   = nav("perf_child1", "perf_root",    "perf_rootid")
    nav_c1_l1     = nav("perf_child1", "perf_lookup1", "perf_child1lookupid")
    nav_c2_c1     = nav("perf_child2", "perf_child1",  "perf_child1id")
    nav_c3_c2     = nav("perf_child3", "perf_child2",  "perf_child2id")

    # Child1
    print(f"\n[3/5] Seeding children (fanout={child_fanout})...")
    c1_payloads = []
    c1_root_map = []  # (root_guid) for each c1 record (same index)
    for root_id in root_guids:
        for j in range(child_fanout):
            l1_id = rng.choice(pool["l1"])
            c1_payloads.append({
                "perf_name":     f"PERF-C1-{len(c1_payloads):06d}",
                "perf_text":     f"c1text{j}",
                "perf_number":   rng.randint(0, 500),
                "perf_amount":   round(rng.uniform(0.0, 2000.0), 2),
                "perf_flag":     rng.choice([True, False]),
                "perf_category": rng.choice(profiles.CATEGORY_OPTIONS),
                "perf_date":     dates(),
                f"{nav_c1_root}@odata.bind": f"/perf_roots({root_id})",
                f"{nav_c1_l1}@odata.bind":   f"/perf_lookup1s({l1_id})",
            })
            c1_root_map.append(root_id)
    c1_guids = bulk_create("perf_child1s", c1_payloads, "child1")
    print(f"  Child1 created: {len(c1_guids)}")

    # Child2
    c2_payloads = []
    for c1_id in c1_guids:
        for j in range(child_fanout):
            c2_payloads.append({
                "perf_name":     f"PERF-C2-{len(c2_payloads):07d}",
                "perf_text":     f"c2text{j}",
                "perf_number":   rng.randint(0, 500),
                "perf_amount":   round(rng.uniform(0.0, 1000.0), 2),
                "perf_flag":     rng.choice([True, False]),
                "perf_category": rng.choice(profiles.CATEGORY_OPTIONS),
                "perf_date":     dates(),
                f"{nav_c2_c1}@odata.bind": f"/perf_child1s({c1_id})",
            })
    c2_guids = bulk_create("perf_child2s", c2_payloads, "child2")
    print(f"  Child2 created: {len(c2_guids)}")

    # Child3
    c3_payloads = []
    for c2_id in c2_guids:
        for j in range(child_fanout):
            c3_payloads.append({
                "perf_name":     f"PERF-C3-{len(c3_payloads):08d}",
                "perf_text":     f"c3text{j}",
                "perf_number":   rng.randint(0, 200),
                "perf_amount":   round(rng.uniform(0.0, 500.0), 2),
                "perf_flag":     rng.choice([True, False]),
                "perf_category": rng.choice(profiles.CATEGORY_OPTIONS),
                "perf_date":     dates(),
                f"{nav_c3_c2}@odata.bind": f"/perf_child2s({c2_id})",
            })
    c3_guids = bulk_create("perf_child3s", c3_payloads, "child3")
    print(f"  Child3 created: {len(c3_guids)}")

    return {"c1": c1_guids, "c2": c2_guids, "c3": c3_guids}


def seed_children_flat(rng, dates, root_guids, pool, rows_per_root):
    """--rows-per-root: exactly rows_per_root perf_child1 rows per root, and no child2/child3."""
    nav_c1_root = nav("perf_child1", "perf_root", "perf_rootid")
    nav_c1_l1 = nav("perf_child1", "perf_lookup1", "perf_child1lookupid")
    print(f"\n[3/5] Seeding {rows_per_root} perf_child1 row(s) per root (flat)...")
    payloads = []
    for root_id in root_guids:
        for j in range(rows_per_root):
            payloads.append(profiles.flat_child_payload(
                len(payloads), j, root_id, rng.choice(pool["l1"]), dates(), nav_c1_root, nav_c1_l1))
    guids = bulk_create("perf_child1s", payloads, "child1")
    print(f"  Child1 created: {len(guids)}")
    return guids


# ---------------------------------------------------------------------------
# Per-type operator + value helpers
# ---------------------------------------------------------------------------

def _numeric_op_and_value(rng, lo, hi, is_decimal=False):
    """Pick a random operator from NUMERIC_OPS and a matching literal value.
    Returns (op, value_str).  Ordering operators are safe only for numeric columns.
    """
    op = rng.choice(NUMERIC_OPS)
    if is_decimal:
        value = str(round(rng.uniform(lo, hi), 2))
    else:
        value = str(rng.randint(int(lo), int(hi)))
    return op, value


def _string_op_and_value(rng, sample_values):
    """Pick a random operator from STRING_OPS and a matching literal value.
    Returns (op, value_str).  For IsNull/IsNotNull, value_str is None (omitted by _cond_fieldcmp).
    """
    op = rng.choice(STRING_OPS)
    if op in (OP_IS_NULL, OP_IS_NOT_NULL):
        return op, None
    # For Equals/NotEquals/Contains/DoesNotContain a concrete string is needed.
    return op, rng.choice(sample_values)


def _bool_op_and_value(rng):
    """Pick Equals or NotEquals and a bool literal. Returns (op, value_str)."""
    op = rng.choice(BOOL_OPS)
    return op, rng.choice(["1", "0"])


def _choice_op_and_value(rng):
    """Pick Equals or NotEquals and a category option value. Returns (op, value_str)."""
    op = rng.choice(CHOICE_OPS)
    return op, str(rng.choice(profiles.CATEGORY_OPTIONS))


# ---------------------------------------------------------------------------
# Rule + record shape builders
# Each helper returns a dict:
#   {
#     "rule":        <asx_rule payload dict>,
#     "groups":      [<group payload>, ...],
#     "conditions":  [(group_index, <condition payload>), ...],
#     "actions":     [<action payload>, ...],
#   }
# GUIDs for rule/group are injected by the caller after bulk-create.
# ---------------------------------------------------------------------------

def _group_payload(rule_id, op, is_exec=False):
    nav_cg_rule = nav("asx_conditiongroup", "asx_rule", "asx_rule")
    return {
        "asx_name":                 f"grp-{rule_id[:8]}",
        "asx_logicaloperator":      op,           # LOG_AND=1 or LOG_OR=2; docs/Schema.md s1
        "asx_isexecutioncondition": is_exec,
        f"{nav_cg_rule}@odata.bind": f"/asx_rules({rule_id})",
    }


def _cond_fieldcmp(group_id, tc_id, col, op, value, src=SRC_LITERAL, val_node_id=None, val_col=None):
    """FieldComparison condition payload.

    For IsNull / IsNotNull operators (OP_IS_NULL=9, OP_IS_NOT_NULL=10) pass value=None;
    asx_comparisonvalue is omitted entirely — the engine evaluates nullness without a RHS.
    """
    nav_cond_cg = nav("asx_rulecondition", "asx_conditiongroup", "asx_conditiongroup")
    nav_cond_tc = nav("asx_rulecondition", "asx_tableconfig", "asx_tableconfig")
    p = {
        "asx_name":                  f"cond-{group_id[:8]}-{col}",
        "asx_conditiontype":         COND_FIELD,   # docs/Schema.md s1; author-rules.py line 94
        "asx_comparisoncolumn":      col,
        "asx_comparisonoperator":    op,
        "asx_comparisonvaluesource": src,
        f"{nav_cond_cg}@odata.bind": f"/asx_conditiongroups({group_id})",
        f"{nav_cond_tc}@odata.bind": f"/asx_tableconfigs({tc_id})",
    }
    # IsNull / IsNotNull need no comparison value — omit asx_comparisonvalue entirely.
    value_less_ops = (OP_IS_NULL, OP_IS_NOT_NULL)
    if src == SRC_LITERAL and op not in value_less_ops:
        p["asx_comparisonvalue"] = str(value)
    if src == SRC_FIELDREF:
        p["asx_comparisonvaluecolumn"] = val_col
        if val_node_id:
            nav_val_node = nav("asx_rulecondition", "asx_tableconfig", "asx_comparisonvaluenode")
            p[f"{nav_val_node}@odata.bind"] = f"/asx_tableconfigs({val_node_id})"
    return p


def _cond_rowcount(group_id, tc_id, min_rows, max_rows=None):
    """RowCount condition payload."""
    nav_cond_cg = nav("asx_rulecondition", "asx_conditiongroup", "asx_conditiongroup")
    nav_cond_tc = nav("asx_rulecondition", "asx_tableconfig", "asx_tableconfig")
    p = {
        "asx_name":                  f"cond-{group_id[:8]}-rowcount",
        "asx_conditiontype":         COND_ROWCOUNT,  # docs/Schema.md s1; author-rules.py line 123
        "asx_minexpectedrows":       min_rows,
        "asx_comparisonvaluesource": SRC_LITERAL,
        f"{nav_cond_cg}@odata.bind": f"/asx_conditiongroups({group_id})",
        f"{nav_cond_tc}@odata.bind": f"/asx_tableconfigs({tc_id})",
    }
    if max_rows is not None:
        p["asx_maxexpectedrows"] = max_rows
    return p


def _action_showmsg(rule_id, msg, severity=1, fireon=FIREON_MATCH):
    nav_act_rule = nav("asx_ruleaction", "asx_rule", "asx_rule")
    return {
        "asx_name":      f"act-{rule_id[:8]}-msg",
        "asx_actiontype": profiles.ACT_SHOWMSG,  # docs/Schema.md s1; author-rules.py line 149
        "asx_fireon":    fireon,             # FIREON_MATCH=1; docs/Schema.md s1
        "asx_message":   msg,
        "asx_severity":  severity,
        "asx_order":     1,
        "asx_isactive":  True,
        f"{nav_act_rule}@odata.bind": f"/asx_rules({rule_id})",
    }


def _action_block(rule_id, msg, severity=3, fireon=FIREON_NOMATCH):
    nav_act_rule = nav("asx_ruleaction", "asx_rule", "asx_rule")
    return {
        "asx_name":      f"act-{rule_id[:8]}-block",
        "asx_actiontype": profiles.ACT_BLOCK,  # docs/Schema.md s1; author-rules.py line 116
        "asx_fireon":    fireon,              # FIREON_NOMATCH=2; docs/Schema.md s1
        "asx_message":   msg,
        "asx_severity":  severity,
        "asx_order":     1,
        "asx_isactive":  True,
        f"{nav_act_rule}@odata.bind": f"/asx_rules({rule_id})",
    }


# ---------------------------------------------------------------------------
# Rule-shape helpers — each returns (groups_list, conditions_per_group, actions_list)
# groups_list: list of group payloads (without rule binding yet)
# conditions_per_group: list of (group_index, condition_payload)
# actions_list: list of action payloads (without rule binding yet)
# ---------------------------------------------------------------------------

def make_root_rule(rng, rule_id, tc_ids):
    """Root field-compare: compare a typed field on the root node.
    Column is chosen first; operator is then drawn from that column's type-safe pool.
    """
    group = _group_payload(rule_id, LOG_AND)
    col = rng.choice(["perf_number", "perf_amount", "perf_flag"])
    if col == "perf_flag":
        op, value = _bool_op_and_value(rng)
    elif col == "perf_number":
        op, value = _numeric_op_and_value(rng, 0, 1000)
    else:  # perf_amount
        op, value = _numeric_op_and_value(rng, 0.0, 50000.0, is_decimal=True)
    cond = _cond_fieldcmp(rule_id, tc_ids["PERF Root"], col, op, value)
    action = _action_showmsg(rule_id, f"PERF-RULE root field check: {col}", severity=1)
    return [group], [(0, cond)], [action]


def make_sibling_lookup_rule(rng, rule_id, tc_ids, lookup_breadth):
    """Sibling-lookup field-ref: compare root field against a sibling-lookup field."""
    sib_count = min(lookup_breadth, 6)
    sib_key = f"PERF Sib{rng.randint(1, sib_count)}"
    group = _group_payload(rule_id, LOG_AND)
    # Compare root perf_number == sibling perf_number (FieldReference).
    # Equality only: ordering ops throw if the field-ref RHS resolves non-numeric at runtime.
    cond = _cond_fieldcmp(
        rule_id, tc_ids["PERF Root"],
        col="perf_number",
        op=OP_EQUALS,
        value=None,
        src=SRC_FIELDREF,
        val_node_id=tc_ids[sib_key],
        val_col="perf_number",
    )
    action = _action_showmsg(rule_id, f"PERF-RULE sibling {sib_key} field ref", severity=1)
    return [group], [(0, cond)], [action]


def make_lookup_rule(rng, rule_id, tc_ids, level):
    """L1/L2/L3 lookup field-compare: a condition on a lookup node's field.
    Column is chosen first; operator is drawn from that column's type-safe pool.
    """
    level_map = {1: "PERF L1", 2: "PERF L2", 3: "PERF L3"}
    tc_name = level_map[level]
    group = _group_payload(rule_id, LOG_AND)
    col = rng.choice(["perf_number", "perf_amount", "perf_text"])
    if col == "perf_text":
        sample_vals = [f"l{level}text{i}" for i in range(11)]
        op, value = _string_op_and_value(rng, sample_vals)
    elif col == "perf_number":
        op, value = _numeric_op_and_value(rng, 0, 500)
    else:  # perf_amount
        op, value = _numeric_op_and_value(rng, 0.0, 2500.0, is_decimal=True)
    cond = _cond_fieldcmp(rule_id, tc_ids[tc_name], col, op, value)
    action = _action_block(rule_id, f"PERF-RULE L{level} field check: {col}", severity=3)
    return [group], [(0, cond)], [action]


def make_child_rowcount_rule(rng, rule_id, tc_ids, level):
    """RowCount condition on child1/2/3."""
    child_map = {1: "PERF Child1", 2: "PERF Child2", 3: "PERF Child3"}
    tc_name = child_map[level]
    group = _group_payload(rule_id, LOG_AND)
    min_rows = rng.randint(1, 5)
    cond = _cond_rowcount(rule_id, tc_ids[tc_name], min_rows=min_rows)
    action = _action_block(rule_id,
                           f"PERF-RULE Child{level} must have >={min_rows} rows",
                           severity=3, fireon=FIREON_NOMATCH)
    return [group], [(0, cond)], [action]


def make_child_fieldcompare_rule(rng, rule_id, tc_ids, level):
    """FieldComparison on a child node field.
    Column is chosen first; operator is drawn from that column's type-safe pool.
    """
    child_map = {1: "PERF Child1", 2: "PERF Child2", 3: "PERF Child3"}
    tc_name = child_map[level]
    group = _group_payload(rule_id, LOG_AND)
    col = rng.choice(["perf_number", "perf_flag", "perf_amount"])
    if col == "perf_flag":
        op, value = _bool_op_and_value(rng)
    elif col == "perf_number":
        op, value = _numeric_op_and_value(rng, 0, 250)
    else:  # perf_amount
        op, value = _numeric_op_and_value(rng, 0.0, 1000.0, is_decimal=True)
    cond = _cond_fieldcmp(rule_id, tc_ids[tc_name], col, op, value)
    action = _action_showmsg(rule_id, f"PERF-RULE Child{level} field {col}", severity=2)
    return [group], [(0, cond)], [action]


def make_childlevel_lookup_rule(rng, rule_id, tc_ids):
    """Child-level lookup field-ref: condition on PERF Child1 Lookup node.
    Both candidate columns are numeric — operator drawn from NUMERIC_OPS.
    """
    group = _group_payload(rule_id, LOG_AND)
    col = rng.choice(["perf_number", "perf_amount"])
    if col == "perf_number":
        op, value = _numeric_op_and_value(rng, 0, 500)
    else:  # perf_amount
        op, value = _numeric_op_and_value(rng, 0.0, 2000.0, is_decimal=True)
    cond = _cond_fieldcmp(rule_id, tc_ids["PERF Child1 Lookup"], col, op, value)
    action = _action_showmsg(rule_id, f"PERF-RULE Child1Lookup {col}", severity=1)
    return [group], [(0, cond)], [action]


def make_selfref_rule(rng, rule_id, tc_ids):
    """Self-reference: compare root field against PERF Self (perf_parentrootid) field."""
    group = _group_payload(rule_id, LOG_AND)
    # Equality only: the parent (perf_parentrootid) may be null on some roots, so an
    # ordering op would hit the string path and throw "Unsupported ComparisonOperator".
    cond = _cond_fieldcmp(
        rule_id, tc_ids["PERF Root"],
        col="perf_number",
        op=OP_EQUALS,
        value=None,
        src=SRC_FIELDREF,
        val_node_id=tc_ids["PERF Self"],
        val_col="perf_number",
    )
    action = _action_showmsg(rule_id, "PERF-RULE self-ref: root.number == parent.number", severity=2)
    return [group], [(0, cond)], [action]


def make_and_or_rule(rng, rule_id, tc_ids, lookup_breadth):
    """Multi-condition AND/OR group: AND group with 2 conditions, or OR group with 2 conditions."""
    use_or = rng.choice([True, False])
    op = LOG_OR if use_or else LOG_AND
    group = _group_payload(rule_id, op)

    # Condition 1: root perf_number compare (equality only — see operator-pool note)
    cond1 = _cond_fieldcmp(
        rule_id, tc_ids["PERF Root"],
        col="perf_number",
        op=OP_NOT_EQUALS,
        value=str(rng.randint(100, 500)),
    )
    cond1["asx_name"] = f"cond-{rule_id[:8]}-multi-1"

    # Condition 2: root perf_flag or category compare
    col2 = rng.choice(["perf_flag", "perf_category"])
    if col2 == "perf_flag":
        cond2 = _cond_fieldcmp(rule_id, tc_ids["PERF Root"], "perf_flag", OP_EQUALS, "1")
    else:
        cat_val = rng.choice(profiles.CATEGORY_OPTIONS)  # 30001/30002/30003 — create-schema.py line 231
        cond2 = _cond_fieldcmp(rule_id, tc_ids["PERF Root"], "perf_category", OP_EQUALS,
                               str(cat_val))
    cond2["asx_name"] = f"cond-{rule_id[:8]}-multi-2"

    action = _action_showmsg(
        rule_id, f"PERF-RULE {'OR' if use_or else 'AND'} multi-condition", severity=1,
        fireon=FIREON_MATCH
    )
    return [group], [(0, cond1), (0, cond2)], [action]


# ---------------------------------------------------------------------------
# Rule-shape table + round-robin distributor
# ---------------------------------------------------------------------------

SHAPE_NAMES = [
    "root_field",
    "sibling_lookup",
    "lookup_l1",
    "lookup_l2",
    "lookup_l3",
    "child_rowcount_1",
    "child_rowcount_2",
    "child_rowcount_3",
    "child_fieldcmp_1",
    "child_fieldcmp_2",
    "child_fieldcmp_3",
    "childlevel_lookup",
    "selfref",
    "and_or",
]


def build_shape(shape_name, rng, rule_id, tc_ids, lookup_breadth):
    """Dispatch to the correct maker. Returns (groups, conditions_per_group, actions)."""
    if shape_name == "root_field":
        return make_root_rule(rng, rule_id, tc_ids)
    elif shape_name == "sibling_lookup":
        return make_sibling_lookup_rule(rng, rule_id, tc_ids, lookup_breadth)
    elif shape_name == "lookup_l1":
        return make_lookup_rule(rng, rule_id, tc_ids, 1)
    elif shape_name == "lookup_l2":
        return make_lookup_rule(rng, rule_id, tc_ids, 2)
    elif shape_name == "lookup_l3":
        return make_lookup_rule(rng, rule_id, tc_ids, 3)
    elif shape_name == "child_rowcount_1":
        return make_child_rowcount_rule(rng, rule_id, tc_ids, 1)
    elif shape_name == "child_rowcount_2":
        return make_child_rowcount_rule(rng, rule_id, tc_ids, 2)
    elif shape_name == "child_rowcount_3":
        return make_child_rowcount_rule(rng, rule_id, tc_ids, 3)
    elif shape_name == "child_fieldcmp_1":
        return make_child_fieldcompare_rule(rng, rule_id, tc_ids, 1)
    elif shape_name == "child_fieldcmp_2":
        return make_child_fieldcompare_rule(rng, rule_id, tc_ids, 2)
    elif shape_name == "child_fieldcmp_3":
        return make_child_fieldcompare_rule(rng, rule_id, tc_ids, 3)
    elif shape_name == "childlevel_lookup":
        return make_childlevel_lookup_rule(rng, rule_id, tc_ids)
    elif shape_name == "selfref":
        return make_selfref_rule(rng, rule_id, tc_ids)
    elif shape_name == "and_or":
        return make_and_or_rule(rng, rule_id, tc_ids, lookup_breadth)
    else:
        raise ValueError(f"Unknown shape: {shape_name}")


# ---------------------------------------------------------------------------
# Rule seeding
# ---------------------------------------------------------------------------

def seed_rules(rng, rule_count, tc_ids, lookup_breadth, block_as_message=False):
    """Create asx_rule + conditiongroup + rulecondition + ruleaction records. Rules are created as
    Draft (no statuscode); publish_rules publishes them afterward with a statuscode PATCH, exactly
    as the Rule Builder does. block_as_message downgrades every Block action to a Show Message
    (profiles.downgrade_block) — used by save-driven profiles so a seeded rule can never fail the
    save being measured.
    Returns (shape_distribution, rule_guids)."""
    print(f"\n[4/5] Seeding {rule_count} asx_rule records...")

    if rule_count == 0:
        return {}, []

    shape_distribution = {s: 0 for s in SHAPE_NAMES}
    nav_root_tc = nav("asx_rule", "asx_tableconfig", "asx_roottableconfig")

    # Step 1: bulk-create asx_rule records (Draft — no statuscode; publish_rules publishes them)
    rule_payloads = []
    rule_shapes = []
    for i in range(rule_count):
        shape = SHAPE_NAMES[i % len(SHAPE_NAMES)]
        rule_shapes.append(shape)
        shape_distribution[shape] += 1
        rule_payloads.append({
            "asx_name":             f"PERF-RULE-{i:04d}",
            "asx_tablelogicalname": "perf_root",
            "asx_triggers":         TRIG_ON_UPDATE,  # "4" — docs/Schema.md s1 On Update=4
            f"{nav_root_tc}@odata.bind": f"/asx_tableconfigs({tc_ids['PERF Root']})",
        })

    rule_guids = bulk_create("asx_rules", rule_payloads, "rules")
    print(f"  Rules created: {len(rule_guids)}")

    # Step 2: create groups, conditions, actions per rule
    all_groups_payloads = []     # (rule_guid, group_payload)
    all_group_meta = []          # (rule_index, group_local_index, conditions_for_this_group)
    all_actions_payloads = []    # (rule_guid, action_payload)

    nav_cg_rule = nav("asx_conditiongroup", "asx_rule", "asx_rule")

    for ri, (rule_id, shape) in enumerate(zip(rule_guids, rule_shapes)):
        groups, cond_per_group, actions = build_shape(shape, rng, rule_id, tc_ids, lookup_breadth)

        for gi, grp in enumerate(groups):
            # Inject proper rule binding and unique name
            grp = dict(grp)
            grp["asx_name"] = f"grp-RULE{ri:04d}-g{gi}"
            grp[f"{nav_cg_rule}@odata.bind"] = f"/asx_rules({rule_id})"
            all_groups_payloads.append((ri, gi, grp))

        for gi, cond in cond_per_group:
            all_group_meta.append((ri, gi, cond))

        for act in actions:
            act = dict(act)
            if block_as_message:
                act = profiles.downgrade_block(act)
            nav_act_rule = nav("asx_ruleaction", "asx_rule", "asx_rule")
            act[f"{nav_act_rule}@odata.bind"] = f"/asx_rules({rule_id})"
            all_actions_payloads.append((ri, act))

    # Bulk-create groups
    group_payloads_only = [p for (_, _, p) in all_groups_payloads]
    group_guids = bulk_create("asx_conditiongroups", group_payloads_only, "groups")
    print(f"  Groups created: {len(group_guids)}")

    # Build (rule_index, group_local_index) -> group_guid mapping
    group_guid_map = {}
    for idx, (ri, gi, _) in enumerate(all_groups_payloads):
        group_guid_map[(ri, gi)] = group_guids[idx]

    # Build condition payloads with actual group GUIDs
    nav_cond_cg = nav("asx_rulecondition", "asx_conditiongroup", "asx_conditiongroup")
    cond_payloads = []
    for ci, (ri, gi, cond) in enumerate(all_group_meta):
        cond = dict(cond)
        group_id = group_guid_map[(ri, gi)]
        cond[f"{nav_cond_cg}@odata.bind"] = f"/asx_conditiongroups({group_id})"
        cond["asx_name"] = f"cond-RULE{ri:04d}-g{gi}-{ci}"
        cond_payloads.append(cond)

    cond_guids = bulk_create("asx_ruleconditions", cond_payloads, "conditions")
    print(f"  Conditions created: {len(cond_guids)}")

    # Bulk-create actions
    action_payloads_only = [p for (_, p) in all_actions_payloads]
    action_guids = bulk_create("asx_ruleactions", action_payloads_only, "actions")
    print(f"  Actions created: {len(action_guids)}")

    return shape_distribution, rule_guids


def publish_rules(rule_ids):
    """Publish each rule exactly as the Rule Builder does: a statuscode-only PATCH. RulePublishPlugin
    validates it and snapshots a revision; RuleRegistrationPlugin registers the RulesEnginePlugin
    steps a save needs. A rule the validator rejects stops the run with its message."""
    print(f"\n[5/5] Publishing {len(rule_ids)} rule(s)...")
    for i, rule_id in enumerate(rule_ids, 1):
        _dv.patch(f"asx_rules({rule_id})", {"statuscode": PUBLISHED}, solution=False)
        if i % 10 == 0 or i == len(rule_ids):
            print(f"  published {i}/{len(rule_ids)}")


def author_spec(spec, tc_ids):
    """Create one profile rule as a Draft: rule, group, conditions (+ node filters) and actions
    (+ Rows filters), mirroring client/test-dev/ruleBehavior/authoring.ts. Returns the rule id."""
    rule_id = post("asx_rules", profiles.rule_payload(spec, tc_ids, nav))
    group_id = post("asx_conditiongroups", profiles.group_payload(spec, rule_id, nav))
    for i, cond in enumerate(spec["conditions"]):
        condition_id = post("asx_ruleconditions", profiles.condition_payload(cond, i, spec["name"], group_id, tc_ids, nav))
        if cond.get("filter"):
            fg = post("asx_nodefiltergroups", profiles.condition_filter_group_payload(cond, group_id, condition_id, tc_ids, nav))
            for crit in cond["filter"]:
                post("asx_nodefiltercriterions", profiles.criterion_payload(crit, fg, nav))
    for i, action in enumerate(spec["actions"]):
        action_id = post("asx_ruleactions", profiles.action_payload(action, i, spec["name"], rule_id, tc_ids, nav))
        if action.get("rowFilter"):
            fg = post("asx_nodefiltergroups", profiles.row_filter_group_payload(action, action_id, tc_ids, nav))
            for crit in action["rowFilter"]:
                post("asx_nodefiltercriterions", profiles.criterion_payload(crit, fg, nav))
    print(f"  Authored {spec['name']} ({rule_id})")
    return rule_id


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Perf volume generator: seed lookup pool, roots, children, and rules."
    )
    parser.add_argument("--rules", type=int, default=None,
                        help="Background asx_rule records (default: 100, or the profile's default: S1/S2/S6 100, S3/S4/S5 0)")
    parser.add_argument("--records",        type=int, default=100, help="Number of perf_root records (default 100)")
    parser.add_argument("--child-fanout",   type=int, default=10,  help="Child fan-out per level (default 10)")
    parser.add_argument("--rows-per-root", type=int, default=None,
                        help="Flat mode: exactly N perf_child1 rows per root and no child2/child3 (overrides --child-fanout)")
    parser.add_argument("--lookup-breadth", type=int, default=4,   help="Sibling lookups per root (max 6, default 4)")
    parser.add_argument("--seed",           type=int, default=1234, help="Random seed (default 1234)")
    parser.add_argument("--profile", choices=profiles.PROFILES, default=None,
                        help="Add a scenario's rule shapes (see README)")
    parser.add_argument("--profile-step", type=int, default=1,
                        help="S5: number of scheduled rules (1-50); S6: number of tables compared (1-7)")
    args = parser.parse_args()

    background = args.rules if args.rules is not None else (
        profiles.DEFAULT_BACKGROUND[args.profile] if args.profile else 100)
    try:
        # Built (and the step validated) before anything is written.
        specs = profiles.rule_specs(args.profile, args.profile_step) if args.profile else []
    except ValueError as e:
        parser.error(str(e))

    rng = random.Random(args.seed)
    date_rng = random.Random(args.seed + 1)
    today = datetime.date.today()
    dates = lambda: profiles.date_value(date_rng, today)  # noqa: E731

    print("=== PERF volume generator ===")
    if args.rows_per_root is not None:
        print(f"  --records={args.records}  --rows-per-root={args.rows_per_root} (flat)")
    else:
        print(f"  --records={args.records}  --child-fanout={args.child_fanout}")
    print(f"  background rules={background}  --lookup-breadth={args.lookup_breadth}  --seed={args.seed}")
    if args.profile:
        print(f"  --profile={args.profile}  --profile-step={args.profile_step}  ({len(specs)} profile rule(s))")

    # Resolve tableconfig IDs from Dataverse (author-config.py must have run first)
    print("\nResolving tableconfig IDs...")
    tc_ids = resolve_tableconfig_ids()
    print(f"  Resolved {len(tc_ids)} tableconfig nodes: {sorted(tc_ids.keys())}")

    # 1. Shared lookup pool (20 each of L3/L2/L1)
    pool = seed_lookup_pool(rng, dates, pool_size=20)

    # 2. perf_root records
    root_guids = seed_roots(rng, dates, args.records, pool, args.lookup_breadth,
                            patch_self_refs=args.profile not in profiles.NO_SELF_REF_PROFILES)

    # 3. Children (multiplicative fan-out, or flat rows-per-root)
    if args.rows_per_root is not None:
        child_counts = {"c1": seed_children_flat(rng, dates, root_guids, pool, args.rows_per_root), "c2": [], "c3": []}
    else:
        child_counts = seed_children(rng, dates, root_guids, pool, args.child_fanout)

    # 4. Rules — created as Draft, then published one by one (publish_rules). Profile rules are
    # authored after the background rules, so a profile shape the validator refuses still leaves
    # the background rules for the next reset to clean.
    shape_dist, rule_guids = seed_rules(rng, background, tc_ids, args.lookup_breadth,
                                        block_as_message=args.profile in profiles.SAVE_PROFILES)
    if specs:
        print(f"  Authoring {len(specs)} {args.profile} profile rule(s)...")
    profile_ids = [author_spec(spec, tc_ids) for spec in specs]
    publish_rules(rule_guids + profile_ids)
    for spec, rule_id in zip(specs, profile_ids):
        if spec.get("schedule"):
            # After publishing: a schedule belongs to the published rule. Next run on is engine-owned.
            post("asx_ruleschedules", profiles.schedule_payload(spec["schedule"], rule_id, nav), solution=False)
            print(f"  Scheduled {spec['name']} every {spec['schedule']['every']} minutes")

    # Summary — the effective rule count is len(rule_guids) (what was actually seeded and
    # published), not args.rules.
    n_roots  = len(root_guids)
    n_child1 = len(child_counts["c1"])
    n_child2 = len(child_counts["c2"])
    n_child3 = len(child_counts["c3"])
    n_rules  = len(rule_guids)

    print("\n=== DONE ===")
    print(f"  Lookup pool:  L3={len(pool['l3'])}, L2={len(pool['l2'])}, L1={len(pool['l1'])}")
    print(f"  Data totals:  roots={n_roots}, child1={n_child1}, child2={n_child2}, child3={n_child3}")
    print(f"  Rules:        {n_rules} background (published through the Rule Builder path, trigger=OnUpdate)")
    if args.profile:
        n_scheduled = sum(1 for s in specs if s.get("schedule"))
        print(f"  Profile:      {args.profile} step {args.profile_step}: {len(profile_ids)} rule(s) published, "
              f"{n_scheduled} scheduled")
    print(f"\nShape distribution ({n_rules} rules across {len(SHAPE_NAMES)} shapes):")
    for shape, count in shape_dist.items():
        print(f"    {shape:<22} {count}")


if __name__ == "__main__":
    main()
