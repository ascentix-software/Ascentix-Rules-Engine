"""Scenario profiles for the perf harness (docs/superpowers/specs/2026-09-29-performance-baseline-design.md).

Pure: no Dataverse access, so test_profiles.py covers it without an environment. generate.py does
the posting. This module holds the flat per-root child rows, their dates, the Block downgrade used
for save-driven profiles, and (Task 6) each profile's rule shapes and payload builders. It is also
the single home for the harness constants shared across profiles.py, generate.py and run-scenario.py
(option-set values, CATEGORY_OPTIONS, SAVE_PROFILES, S3_FIRE_MARKER, ...) — the others import this
module rather than redefining them.
"""
import datetime
import json

CATEGORY_OPTIONS = [30001, 30002, 30003]   # perf_category, create-schema.py add_typed_columns

# ---------------------------------------------------------------------------
# Option-set values (docs/Schema.md §1; author-rules.py)
# ---------------------------------------------------------------------------
TRIG_ON_DEMAND, TRIG_ON_UPDATE = "3", "4"          # asx_triggers (multi-select: a comma-separated string)

COND_FIELD, COND_ROWCOUNT, COND_EXPRESSION = 1, 2, 4   # asx_conditiontype (Expression = Calculation)

OP_EQUALS       = 1                                # asx_comparisonoperator
OP_NOT_EQUALS   = 2
OP_GT           = 3
OP_GTE          = 4
OP_LT           = 5
OP_LTE          = 6
OP_CONTAINS     = 7
OP_NOT_CONTAINS = 8
OP_IS_NULL      = 9
OP_IS_NOT_NULL  = 10

SRC_LITERAL, SRC_FIELDREF, SRC_DATEEXPR = 1, 2, 4  # asx_comparisonvaluesource

LOG_AND, LOG_OR = 1, 2                             # asx_logicaloperator

# The profiles keep the readable "fireOn" shorthand; it is never sent (the engine no longer reads
# asx_fireon). fires_when_tree translates it into a Fires when tree, as the migration script does.
FIREON_MATCH, FIREON_NOMATCH = 1, 2

ACT_SHOWMSG = 3                                    # asx_actiontype
ACT_BLOCK = 4
ACT_CREATE, ACT_UPDATE, ACT_DELETE, ACT_DEACTIVATE = 5, 6, 7, 8

SCOPE_ALL_RECORDS = 2                              # asx_ondemandscope
PATTERN_EVERY_MINUTES = 1                          # asx_ruleschedule.asx_pattern
CRITERION_COMPARISON = 1                           # asx_nodefiltercriterion.asx_criteriontype


def _json(value):
    return json.dumps(value, separators=(",", ":"))


def date_value(date_rng, today):
    """A perf_date value (DateOnly, User Local: an Edm.DateTimeOffset at UTC midnight), 0-60 days
    before today. Drawn from its own random stream so the other generated values keep their
    existing sequence."""
    day = today - datetime.timedelta(days=date_rng.randint(0, 60))
    return day.isoformat() + "T00:00:00Z"


def flat_child_payload(index, j, root_id, l1_id, date_val, nav_root, nav_l1):
    """The j-th perf_child1 row of a root in --rows-per-root mode. Values are position-based, not
    random, so a step's partitions are exact: perf_category cycles 30001/30002/30003 (S3 splits its
    set actions on it). date_val (not date_value, to avoid shadowing the module function above) is
    the already-computed perf_date string for this row."""
    return {
        "perf_name":     f"PERF-C1-{index:06d}",
        "perf_text":     f"c1text{j}",
        "perf_number":   j % 500,
        "perf_amount":   float(j % 2000),
        "perf_flag":     j % 2 == 0,
        "perf_category": CATEGORY_OPTIONS[j % 3],
        "perf_date":     date_val,
        f"{nav_root}@odata.bind": f"/perf_roots({root_id})",
        f"{nav_l1}@odata.bind":   f"/perf_lookup1s({l1_id})",
    }


def downgrade_block(action):
    """A background Block action as a Show Message with the same trigger, text and severity: the same
    condition and traversal cost, but it can never fail the save a save-driven profile measures."""
    if action.get("asx_actiontype") != ACT_BLOCK:
        return action
    return {**action, "asx_actiontype": ACT_SHOWMSG, "asx_name": action["asx_name"].replace("-block", "-msg")}


# ---------------------------------------------------------------------------
# Scenario rule shapes (spec §4 "Rules")
# ---------------------------------------------------------------------------
# A rule spec is plain data: {"name", "triggers", "scope"?, "conditions": [...], "actions": [...],
# "schedule"?}. Nodes are tableconfig names from author-config.py; "<<PERF Child1>>" inside an
# expression is replaced by that node's id. Every name starts PERF-RULE- (reset/teardown remove them).
# Shapes mirror the live suites' authorRule configs (client/test-dev/ruleBehavior/authoring.ts).

PROFILES = ("S1", "S2", "S3", "S4", "S5", "S6")
DEFAULT_BACKGROUND = {"S1": 100, "S2": 100, "S3": 0, "S4": 0, "S5": 0, "S6": 100}
SAVE_PROFILES = ("S2", "S3")          # driven by real saves: background Blocks become Show Message
NO_SELF_REF_PROFILES = ("S4", "S5")   # up to 50,000 roots: skip the one-PATCH-per-root self-ref wiring
S3_FIRE_MARKER = "S3FIRE"             # perf_text containing it fires the S3 set actions

TABLE_NODES = [
    ("perf_root", "PERF Root"), ("perf_lookup1", "PERF L1"), ("perf_lookup2", "PERF L2"), ("perf_lookup3", "PERF L3"),
    ("perf_child1", "PERF Child1"), ("perf_child2", "PERF Child2"), ("perf_child3", "PERF Child3"),
]

# Date expressions (asx_comparisonvaluesource 4). In a node filter, a field anchor with no node reads
# the filtered row itself, so it stays in memory; a now anchor pushes down (PushdownTranslator).
NOW_MINUS_30_DAYS = _json({"anchor": {"kind": "now"}, "op": "subtract", "amount": 30, "unit": "days"})
ROW_CREATED_PLUS_30_DAYS = _json({"anchor": {"kind": "field", "node": None, "column": "createdon"},
                                  "op": "add", "amount": 30, "unit": "days"})
NOW_MINUS_10_YEARS = _json({"anchor": {"kind": "now"}, "op": "subtract", "amount": 10, "unit": "years"})
# asx_expressionfilters map (AggregateFilterParser): filter key -> group; a rule's operator is the
# numeric comparison operator.
CATEGORY_A_FILTERS = {"f1": {"kind": "group", "op": "and", "rules": [
    {"kind": "rule", "column": "perf_category", "operator": OP_EQUALS, "valueSource": SRC_LITERAL, "value": "30001"}]}}


def _show(message):
    return {"type": ACT_SHOWMSG, "fireOn": FIREON_MATCH, "message": message, "severity": 1}


def _category(value, *extra):
    return [{"field": "perf_category", "operator": "eq", "value": str(value)}, *extra]


def _s1():
    """Relative-date filters (a now-anchored one that pushes down, a row-anchored one evaluated in
    memory) and a Calculation condition with a filtered total, all over PERF Child1."""
    return [
        {"name": "PERF-RULE-S1-DATE-NOW", "triggers": TRIG_ON_UPDATE,
         "conditions": [{"type": COND_ROWCOUNT, "node": "PERF Child1", "minRows": 1,
                         "filter": [{"field": "perf_date", "operator": "ge", "source": SRC_DATEEXPR, "value": NOW_MINUS_30_DAYS}]}],
         "actions": [_show("PERF S1 recent child rows")]},
        {"name": "PERF-RULE-S1-DATE-ROW", "triggers": TRIG_ON_UPDATE,
         "conditions": [{"type": COND_ROWCOUNT, "node": "PERF Child1", "minRows": 1,
                         "filter": [{"field": "perf_date", "operator": "le", "source": SRC_DATEEXPR, "value": ROW_CREATED_PLUS_30_DAYS}]}],
         "actions": [_show("PERF S1 child rows dated before creation + 30 days")]},
        {"name": "PERF-RULE-S1-CALC", "triggers": TRIG_ON_UPDATE,
         "conditions": [{"type": COND_EXPRESSION, "node": "PERF Root",
                         "expression": "sum(node:<<PERF Child1>>.perf_amount filter:f1)",
                         "filters": CATEGORY_A_FILTERS, "operator": OP_LTE, "value": "1000000000"}],
         "actions": [_show("PERF S1 category A total")]},
    ]


def _s2():
    """Apply to previous parent over the perf_lookup1 chain: a lookup change re-runs the plan for the
    old L1, re-fetching the child rows the condition reads."""
    return [{"name": "PERF-RULE-S2-PREVIOUS", "triggers": TRIG_ON_UPDATE,
             "conditions": [{"type": COND_ROWCOUNT, "node": "PERF Child1", "minRows": 1}],
             "actions": [{"type": ACT_UPDATE, "fireOn": FIREON_MATCH, "targetNode": "PERF L1",
                          "mapping": [{"target": "perf_number", "source": "root", "column": "perf_number"}],
                          "applyToPrevious": True}]}]


def _s3():
    """Set actions on save, partitioned by perf_category so they don't merge into one delete per row."""
    return [{"name": "PERF-RULE-S3-SET", "triggers": TRIG_ON_UPDATE,
             "conditions": [{"type": COND_FIELD, "node": "PERF Root", "column": "perf_text", "operator": OP_CONTAINS,
                             "source": SRC_LITERAL, "value": S3_FIRE_MARKER}],
             "actions": [
                 {"type": ACT_UPDATE, "fireOn": FIREON_MATCH, "order": 1, "targetNode": "PERF Child1",
                  "mapping": [{"target": "perf_text", "source": "literal", "value": "S3-UPDATED"}],
                  "rowFilter": _category(30001)},
                 {"type": ACT_DEACTIVATE, "fireOn": FIREON_MATCH, "order": 2, "targetNode": "PERF Child1",
                  "rowFilter": _category(30002, {"field": "statecode", "operator": "eq", "value": "0"})},
                 {"type": ACT_DELETE, "fireOn": FIREON_MATCH, "order": 3, "targetNode": "PERF Child1",
                  "rowFilter": _category(30003)},
                 {"type": ACT_CREATE, "fireOn": FIREON_MATCH, "order": 4, "targetNode": "PERF Child1",
                  "targetTable": "perf_followup",
                  "mapping": [{"target": "perf_name", "source": "template", "template": "PERF-FU {row.perf_name}"},
                              {"target": "perf_child1id", "source": "row", "column": "perf_child1id"}],
                  "rowFilter": _category(30001)},
             ]}]


def _s4_read(name):
    return {"name": name, "triggers": TRIG_ON_DEMAND, "scope": SCOPE_ALL_RECORDS,
            "conditions": [{"type": COND_FIELD, "node": "PERF L1", "column": "perf_number", "operator": OP_GTE,
                            "source": SRC_LITERAL, "value": "0"}],
            "actions": [_show("PERF S4 read")]}


def _s4_write(name):
    return {"name": name, "triggers": TRIG_ON_DEMAND, "scope": SCOPE_ALL_RECORDS,
            "conditions": [{"type": COND_ROWCOUNT, "node": "PERF Child1", "minRows": 1}],
            "actions": [{"type": ACT_UPDATE, "fireOn": FIREON_MATCH, "targetNode": "PERF Child1",
                         "mapping": [{"target": "perf_text", "source": "literal", "value": "S4-UPDATED"}],
                         "rowFilter": [{"field": "statecode", "operator": "eq", "value": "0"}]}]}


def _s5(count):
    if not 1 <= count <= 50:
        raise ValueError("S5 takes 1 to 50 schedules (asx_StartDueSchedules takes at most 50 per call)")
    specs = []
    for i in range(count):
        spec = (_s4_read if i % 2 == 0 else _s4_write)(f"PERF-RULE-S5-{i:03d}")
        spec["schedule"] = {"pattern": PATTERN_EVERY_MINUTES, "every": 15}
        specs.append(spec)
    return specs


def _s6(tables):
    if not 1 <= tables <= len(TABLE_NODES):
        raise ValueError(f"S6 compares dates on 1 to {len(TABLE_NODES)} tables")
    return [{"name": f"PERF-RULE-S6-{table}", "triggers": TRIG_ON_UPDATE,
             "conditions": [{"type": COND_FIELD, "node": node, "column": "perf_date", "operator": OP_GTE,
                             "source": SRC_DATEEXPR, "value": NOW_MINUS_10_YEARS}],
             "actions": [_show(f"PERF S6 date on {table}")]}
            for table, node in TABLE_NODES[:tables]]


def rule_specs(profile, step=1):
    """The rules a profile adds on top of the background rules. step: S5 schedules, S6 tables."""
    if profile == "S1":
        return _s1()
    if profile == "S2":
        return _s2()
    if profile == "S3":
        return _s3()
    if profile == "S4":
        return [_s4_read("PERF-RULE-S4-READ"), _s4_write("PERF-RULE-S4-WRITE")]
    if profile == "S5":
        return _s5(step)
    if profile == "S6":
        return _s6(step)
    raise ValueError(f"Unknown profile: {profile}")


# ---------------------------------------------------------------------------
# Web API payloads (nav: the lookup's navigation-property name, resolved from metadata by generate.py)
# ---------------------------------------------------------------------------

def resolve_node_tokens(text, tc_ids):
    for name, node_id in tc_ids.items():
        text = text.replace(f"<<{name}>>", node_id)
    return text


def _bind(nav, entity, referenced, attribute, entity_set, record_id):
    return {f"{nav(entity, referenced, attribute)}@odata.bind": f"/{entity_set}({record_id})"}


def rule_payload(spec, tc_ids, nav):
    """A Draft rule (no statuscode: the revision guard refuses a rule created Published)."""
    p = {"asx_name": spec["name"], "asx_tablelogicalname": "perf_root", "asx_triggers": spec["triggers"],
         **_bind(nav, "asx_rule", "asx_tableconfig", "asx_roottableconfig", "asx_tableconfigs", tc_ids["PERF Root"])}
    if spec.get("scope"):
        p["asx_ondemandscope"] = spec["scope"]
    return p


def group_payload(spec, rule_id, nav):
    return {"asx_name": spec["name"] + "-g", "asx_logicaloperator": LOG_AND, "asx_isexecutioncondition": False,
            **_bind(nav, "asx_conditiongroup", "asx_rule", "asx_rule", "asx_rules", rule_id)}


def condition_payload(cond, index, spec_name, group_id, tc_ids, nav):
    p = {"asx_name": f"{spec_name}-c{index + 1}", "asx_conditiontype": cond["type"],
         **_bind(nav, "asx_rulecondition", "asx_conditiongroup", "asx_conditiongroup", "asx_conditiongroups", group_id),
         **_bind(nav, "asx_rulecondition", "asx_tableconfig", "asx_tableconfig", "asx_tableconfigs", tc_ids[cond["node"]])}
    if cond["type"] == COND_FIELD:
        # The value source is explicit: without it the comparison value is never written.
        p.update({"asx_comparisoncolumn": cond["column"], "asx_comparisonoperator": cond["operator"],
                  "asx_comparisonvaluesource": cond["source"], "asx_comparisonvalue": cond["value"]})
    elif cond["type"] == COND_ROWCOUNT:
        p.update({"asx_minexpectedrows": cond.get("minRows", 0), "asx_comparisonvaluesource": SRC_LITERAL})
        if "maxRows" in cond:
            p["asx_maxexpectedrows"] = cond["maxRows"]
    elif cond["type"] == COND_EXPRESSION:
        p.update({"asx_conditionexpression": resolve_node_tokens(cond["expression"], tc_ids),
                  "asx_expressionfilters": _json(cond["filters"]), "asx_comparisonoperator": cond["operator"],
                  "asx_comparisonvaluesource": SRC_LITERAL, "asx_comparisonvalue": cond["value"]})
    return p


def condition_filter_group_payload(cond, group_id, condition_id, tc_ids, nav):
    """'Only consider records where…' on the condition's own node: one flat AND group."""
    return {"asx_logicaloperator": LOG_AND,
            **_bind(nav, "asx_nodefiltergroup", "asx_conditiongroup", "asx_conditiongroup", "asx_conditiongroups", group_id),
            **_bind(nav, "asx_nodefiltergroup", "asx_rulecondition", "asx_rulecondition", "asx_ruleconditions", condition_id),
            **_bind(nav, "asx_nodefiltergroup", "asx_tableconfig", "asx_tableconfignode", "asx_tableconfigs", tc_ids[cond["node"]])}


def action_payload(action, index, spec_name, rule_id, tc_ids, nav):
    p = {"asx_name": f"{spec_name}-a{index + 1}", "asx_actiontype": action["type"],
         "asx_order": action.get("order", index + 1), "asx_isactive": True,
         **_bind(nav, "asx_ruleaction", "asx_rule", "asx_rule", "asx_rules", rule_id)}
    if "message" in action:
        p["asx_message"] = action["message"]
        p["asx_severity"] = action.get("severity", 1)
    if "targetTable" in action:
        p["asx_targettable"] = action["targetTable"]
    if "mapping" in action:
        p["asx_fieldmapping"] = _json(action["mapping"])
    if "applyToPrevious" in action:
        p["asx_applytoprevious"] = action["applyToPrevious"]
    if "targetNode" in action:
        p.update(_bind(nav, "asx_ruleaction", "asx_tableconfig", "asx_targetnode", "asx_tableconfigs", tc_ids[action["targetNode"]]))
    return p


def fires_when_tree(fire_on, outcome_ids):
    """The Fires when tree equivalent to an old On match / On no match: On match -> ALL of every outcome
    true (no outcomes: an empty ALL, i.e. always); On no match -> ANY of every outcome false (no outcomes:
    it could never fire, so that is an error the profile author must fix)."""
    if fire_on == FIREON_MATCH:
        return {"operator": LOG_AND, "tests": [{"outcome": o, "expected": True} for o in outcome_ids]}
    if fire_on == FIREON_NOMATCH:
        if not outcome_ids:
            raise ValueError("An On no match action needs at least one outcome (its tree would never fire)")
        return {"operator": LOG_OR, "tests": [{"outcome": o, "expected": False} for o in outcome_ids]}
    raise ValueError(f"Unknown fireOn value: {fire_on!r}")


def fires_when_root_payload(tree, action_id, nav):
    return {"asx_logicaloperator": tree["operator"], "asx_order": 1,
            **_bind(nav, "asx_actionconditiongroup", "asx_ruleaction", "asx_ruleaction", "asx_ruleactions", action_id)}


def fires_when_test_payload(test, order, root_id, nav):
    return {"asx_expected": test["expected"], "asx_order": order,
            **_bind(nav, "asx_actionconditiontest", "asx_actionconditiongroup", "asx_actionconditiongroup",
                    "asx_actionconditiongroups", root_id),
            **_bind(nav, "asx_actionconditiontest", "asx_conditiongroup", "asx_outcome", "asx_conditiongroups", test["outcome"])}


def row_filter_group_payload(action, action_id, tc_ids, nav):
    """A set action's Rows filter: one flat AND group on the action's own target node. (Every group of
    a Rows filter carries the action; the profiles use no EXISTS sub-filter, whose root group doesn't.)"""
    return {"asx_logicaloperator": LOG_AND,
            **_bind(nav, "asx_nodefiltergroup", "asx_ruleaction", "asx_ruleaction", "asx_ruleactions", action_id),
            **_bind(nav, "asx_nodefiltergroup", "asx_tableconfig", "asx_tableconfignode", "asx_tableconfigs", tc_ids[action["targetNode"]])}


def criterion_payload(crit, filter_group_id, nav):
    p = {"asx_fieldname": crit["field"], "asx_operator": crit["operator"], "asx_criteriontype": CRITERION_COMPARISON,
         "asx_value": crit["value"],
         **_bind(nav, "asx_nodefiltercriterion", "asx_nodefiltergroup", "asx_filtergroup", "asx_nodefiltergroups", filter_group_id)}
    if crit.get("source") == SRC_DATEEXPR:
        p["asx_comparisonvaluesource"] = SRC_DATEEXPR
    return p


def schedule_payload(schedule, rule_id, nav):
    """No asx_nextrunon: it is engine-owned (RuleSchedulePlugin computes it and strips a supplied one)."""
    return {**_bind(nav, "asx_ruleschedule", "asx_rule", "asx_rule", "asx_rules", rule_id),
            "asx_on": True, "asx_pattern": schedule["pattern"], "asx_every": schedule["every"]}
