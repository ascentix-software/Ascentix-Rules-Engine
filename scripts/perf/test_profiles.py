"""Unit tests for profiles.py (pure; no Dataverse). Run: python scripts/perf/test_profiles.py"""
import datetime
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import profiles  # noqa: E402


def test_flat_children_split_categories_in_exact_thirds():
    rows = [profiles.flat_child_payload(i, i, "root-1", "l1-1", "2026-09-01T00:00:00Z", "perf_RootId", "perf_Child1LookupId")
            for i in range(300)]
    cats = [r["perf_category"] for r in rows]
    assert cats.count(30001) == cats.count(30002) == cats.count(30003) == 100
    assert rows[5]["perf_name"] == "PERF-C1-000005"
    assert rows[0]["perf_RootId@odata.bind"] == "/perf_roots(root-1)"
    assert rows[0]["perf_Child1LookupId@odata.bind"] == "/perf_lookup1s(l1-1)"
    assert rows[0]["perf_date"] == "2026-09-01T00:00:00Z"
    assert all(r["perf_name"].startswith("PERF") for r in rows)


def test_date_values_are_deterministic_utc_midnights_within_sixty_days():
    today = datetime.date(2026, 9, 30)
    rng = random.Random(7)
    first = [profiles.date_value(rng, today) for _ in range(20)]
    rng = random.Random(7)
    second = [profiles.date_value(rng, today) for _ in range(20)]
    assert first == second
    for value in first:
        assert value.endswith("T00:00:00Z")
        day = datetime.date.fromisoformat(value[:10])
        assert today - datetime.timedelta(days=60) <= day <= today


def test_a_block_downgrades_to_a_show_message_with_the_same_text():
    block = {"asx_name": "act-1234abcd-block", "asx_actiontype": 4, "asx_fireon": 2, "asx_message": "m", "asx_severity": 3}
    shown = profiles.downgrade_block(block)
    assert shown["asx_actiontype"] == 3
    assert shown["asx_name"] == "act-1234abcd-msg"
    assert (shown["asx_fireon"], shown["asx_message"], shown["asx_severity"]) == (2, "m", 3)
    other = {"asx_name": "act-x-msg", "asx_actiontype": 3}
    assert profiles.downgrade_block(other) == other


TC = {name: f"id-{i}" for i, (_, name) in enumerate(profiles.TABLE_NODES)}


def fake_nav(entity, referenced, attribute):
    return f"NAV[{entity}.{attribute}]"


def test_s1_adds_a_pushed_date_filter_an_in_memory_one_and_a_filtered_total():
    specs = {s["name"]: s for s in profiles.rule_specs("S1")}
    assert set(specs) == {"PERF-RULE-S1-DATE-NOW", "PERF-RULE-S1-DATE-ROW", "PERF-RULE-S1-CALC"}
    now = specs["PERF-RULE-S1-DATE-NOW"]["conditions"][0]["filter"][0]
    assert now["source"] == 4 and json.loads(now["value"])["anchor"] == {"kind": "now"}
    row = specs["PERF-RULE-S1-DATE-ROW"]["conditions"][0]["filter"][0]
    assert json.loads(row["value"])["anchor"] == {"kind": "field", "node": None, "column": "createdon"}
    calc = specs["PERF-RULE-S1-CALC"]["conditions"][0]
    assert calc["type"] == 4 and "<<PERF Child1>>" in calc["expression"] and "f1" in calc["filters"]
    assert all(s["triggers"] == "4" for s in specs.values())


def test_s2_updates_the_root_lookup_and_its_previous_value():
    (spec,) = profiles.rule_specs("S2")
    (action,) = spec["actions"]
    assert action["type"] == 6 and action["targetNode"] == "PERF L1" and action["applyToPrevious"] is True
    assert spec["conditions"][0]["node"] == "PERF Child1"


def test_s3_is_one_rule_with_partitioned_update_deactivate_delete_and_create_per_row():
    (spec,) = profiles.rule_specs("S3")
    assert [a["type"] for a in spec["actions"]] == [6, 8, 7, 5]
    assert all(a["targetNode"] == "PERF Child1" and a["rowFilter"] for a in spec["actions"])
    categories = [a["rowFilter"][0]["value"] for a in spec["actions"]]
    assert categories == ["30001", "30002", "30003", "30001"]
    assert spec["actions"][3]["targetTable"] == "perf_followup"
    assert spec["conditions"][0]["value"] == profiles.S3_FIRE_MARKER


def test_s4_is_one_read_rule_and_one_set_update_rule_over_all_records():
    specs = profiles.rule_specs("S4")
    assert [s["name"] for s in specs] == ["PERF-RULE-S4-READ", "PERF-RULE-S4-WRITE"]
    assert all(s["triggers"] == "3" and s["scope"] == 2 and "schedule" not in s for s in specs)
    assert specs[0]["actions"][0]["type"] == 3
    assert specs[1]["actions"][0]["type"] == 6 and specs[1]["actions"][0]["targetNode"] == "PERF Child1"


def test_s5_makes_one_scheduled_all_records_rule_per_step():
    specs = profiles.rule_specs("S5", 10)
    assert len(specs) == 10 and len({s["name"] for s in specs}) == 10
    assert all(s["schedule"] == {"pattern": 1, "every": 15} and s["scope"] == 2 for s in specs)
    assert all(s["name"].startswith("PERF-RULE-S5-") for s in specs)
    for bad in (0, 51):
        try:
            profiles.rule_specs("S5", bad)
            assert False, "expected ValueError"
        except ValueError:
            pass


def test_s6_compares_dates_on_the_first_k_tables():
    specs = profiles.rule_specs("S6", 3)
    assert [s["conditions"][0]["node"] for s in specs] == ["PERF Root", "PERF L1", "PERF L2"]
    assert all(s["conditions"][0]["column"] == "perf_date" and s["conditions"][0]["source"] == 4 for s in specs)
    try:
        profiles.rule_specs("S6", 8)
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_every_profile_rule_is_named_for_reset_and_teardown():
    for profile in profiles.PROFILES:
        for spec in profiles.rule_specs(profile, 2):
            assert spec["name"].startswith("PERF-RULE-")


def test_background_defaults_match_the_spec():
    assert profiles.DEFAULT_BACKGROUND == {"S1": 100, "S2": 100, "S3": 0, "S4": 0, "S5": 0, "S6": 100}


def test_payloads_bind_through_the_nav_lookup_and_resolve_node_tokens():
    s1 = {s["name"]: s for s in profiles.rule_specs("S1")}
    calc = profiles.condition_payload(s1["PERF-RULE-S1-CALC"]["conditions"][0], 0, "PERF-RULE-S1-CALC", "g-1", TC, fake_nav)
    assert calc["asx_conditionexpression"] == "sum(node:id-4.perf_amount filter:f1)"
    assert json.loads(calc["asx_expressionfilters"])["f1"]["rules"][0]["value"] == "30001"
    assert calc["NAV[asx_rulecondition.asx_conditiongroup]@odata.bind"] == "/asx_conditiongroups(g-1)"

    (s3,) = profiles.rule_specs("S3")
    create = profiles.action_payload(s3["actions"][3], 3, s3["name"], "r-1", TC, fake_nav)
    assert create["asx_actiontype"] == 5 and create["asx_targettable"] == "perf_followup"
    assert create["NAV[asx_ruleaction.asx_targetnode]@odata.bind"] == "/asx_tableconfigs(id-4)"
    assert json.loads(create["asx_fieldmapping"])[1] == {"target": "perf_child1id", "source": "row", "column": "perf_child1id"}
    rows = profiles.row_filter_group_payload(s3["actions"][3], "a-1", TC, fake_nav)
    assert rows["NAV[asx_nodefiltergroup.asx_ruleaction]@odata.bind"] == "/asx_ruleactions(a-1)"
    crit = profiles.criterion_payload(s3["actions"][0]["rowFilter"][0], "fg-1", fake_nav)
    assert crit == {"asx_fieldname": "perf_category", "asx_operator": "eq", "asx_criteriontype": 1, "asx_value": "30001",
                    "NAV[asx_nodefiltercriterion.asx_filtergroup]@odata.bind": "/asx_nodefiltergroups(fg-1)"}

    s5 = profiles.rule_specs("S5", 1)[0]
    rule = profiles.rule_payload(s5, TC, fake_nav)
    assert rule["asx_ondemandscope"] == 2 and "statuscode" not in rule
    sched = profiles.schedule_payload(s5["schedule"], "r-9", fake_nav)
    assert sched == {"NAV[asx_ruleschedule.asx_rule]@odata.bind": "/asx_rules(r-9)", "asx_on": True, "asx_pattern": 1, "asx_every": 15}


def test_every_field_comparison_writes_its_value_source_and_value():
    # A field comparison without an explicit asx_comparisonvaluesource never gets its value written.
    for profile in profiles.PROFILES:
        for spec in profiles.rule_specs(profile, 7 if profile == "S6" else 2):
            for i, cond in enumerate(spec["conditions"]):
                if cond["type"] != profiles.COND_FIELD:
                    continue
                p = profiles.condition_payload(cond, i, spec["name"], "g-1", TC, fake_nav)
                assert p["asx_comparisonvaluesource"] in (profiles.SRC_LITERAL, profiles.SRC_DATEEXPR)
                assert p["asx_comparisonvalue"] == cond["value"]


def test_a_date_filter_criterion_carries_its_date_expression_source_and_a_condition_filter_binds_three_owners():
    s1 = {s["name"]: s for s in profiles.rule_specs("S1")}
    cond = s1["PERF-RULE-S1-DATE-NOW"]["conditions"][0]
    crit = profiles.criterion_payload(cond["filter"][0], "fg-2", fake_nav)
    assert crit["asx_comparisonvaluesource"] == 4 and crit["asx_value"] == cond["filter"][0]["value"]
    fg = profiles.condition_filter_group_payload(cond, "g-1", "c-1", TC, fake_nav)
    assert fg == {"asx_logicaloperator": 1,
                  "NAV[asx_nodefiltergroup.asx_conditiongroup]@odata.bind": "/asx_conditiongroups(g-1)",
                  "NAV[asx_nodefiltergroup.asx_rulecondition]@odata.bind": "/asx_ruleconditions(c-1)",
                  "NAV[asx_nodefiltergroup.asx_tableconfignode]@odata.bind": "/asx_tableconfigs(id-4)"}


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("OK")
