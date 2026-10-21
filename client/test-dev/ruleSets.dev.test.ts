import { afterEach, describe, expect, it } from "vitest";
import { createRuleFixture } from "../e2e/devHelpers";
import { createDevApi, deleteDevRecord, updateDevRecord } from "./devApi";
import { devOrg } from "./devOrg";
import { ENTITY_SET } from "../src/editor/load/odata";
import { moveRulesBatch, ruleSetErrorMessage, DELETE_SET_BLOCKED } from "../src/editor/save/ruleSetWrites";

// Rule set behaviour on DEV through the client's own write helpers. The REST dev api stands in for
// createWebApiPort (which needs Xrm): sets are created/renamed/deleted by REST, rules are moved by
// the client's moveRulesBatch (a real $batch change set), and every caught error goes through
// ruleSetErrorMessage. Fixtures: ZZ_RB_ rules, ZZ_RS_ sets (swept by sweepRuleBehaviorOrphans).

const api = createDevApi();
const user = devOrg("user");
const rand = () => Math.random().toString(36).slice(2, 8);

const sets: string[] = [];
const rules: Array<{ cleanup: () => Promise<void> }> = [];

async function newSet(): Promise<{ id: string; name: string }> {
  const name = `ZZ_RS_${rand()}`;
  const id = await api.createRecord(ENTITY_SET.ruleSet, { asx_name: name });
  sets.push(id);
  return { id, name };
}

async function newRule(publish = false) {
  const fx = await createRuleFixture({ namePrefix: "ZZ_RB_rs" });
  rules.push(fx);
  if (publish) {
    expect((await api.validateRule(fx.ruleId)).isValid).toBe(true);
    await api.publishRule(fx.ruleId);
  }
  return fx;
}

async function ruleSetOf(ruleId: string): Promise<string | null> {
  const r = await api.retrieveRecord(ENTITY_SET.rule, ruleId, "?$select=_asx_ruleset_value");
  return r._asx_ruleset_value ?? null;
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected the call to fail");
}

afterEach(async () => {
  // Rules first (the set -> rule relationship is Restrict), then their sets.
  for (const r of rules.splice(0)) await r.cleanup().catch(console.warn);
  for (const id of sets.splice(0)) await deleteDevRecord(ENTITY_SET.ruleSet, id).catch(console.warn);
});

describe("rule sets on DEV", () => {
  it("create and rename a rule set; a duplicate name is refused", async () => {
    const a = await newSet();
    const b = await newSet();
    await updateDevRecord(ENTITY_SET.ruleSet, a.id, { asx_name: `${a.name}_renamed` });
    const read = await api.retrieveRecord(ENTITY_SET.ruleSet, a.id, "?$select=asx_name");
    expect(read.asx_name).toBe(`${a.name}_renamed`);

    // Create with an existing name, then rename onto an existing name.
    const dupCreate = await caught(api.createRecord(ENTITY_SET.ruleSet, { asx_name: b.name }));
    expect(ruleSetErrorMessage(dupCreate, b.name)).toBe(`A rule set named ${b.name} already exists.`);
    const dupRename = await caught(updateDevRecord(ENTITY_SET.ruleSet, a.id, { asx_name: b.name }));
    expect(ruleSetErrorMessage(dupRename, b.name)).toBe(`A rule set named ${b.name} already exists.`);
  });

  it("deleting a set with a rule is refused (Restrict), and succeeds once empty", async () => {
    const set = await newSet();
    const rule = await newRule();
    await moveRulesBatch(api, [rule.ruleId], set.id);
    expect(await ruleSetOf(rule.ruleId)).toBe(set.id);

    const refused = await caught(deleteDevRecord(ENTITY_SET.ruleSet, set.id));
    expect(ruleSetErrorMessage(refused)).toBe(DELETE_SET_BLOCKED);

    await moveRulesBatch(api, [rule.ruleId], null);
    await deleteDevRecord(ENTITY_SET.ruleSet, set.id);
    sets.splice(sets.indexOf(set.id), 1);
    await expect(api.retrieveRecord(ENTITY_SET.ruleSet, set.id, "")).rejects.toThrow(/404/);
  });

  it("moveRules moves three rules in one change set; one bad id rolls all back", async () => {
    const set = await newSet();
    const three = [await newRule(), await newRule(), await newRule()];
    const ids = three.map((r) => r.ruleId);
    await moveRulesBatch(api, ids, set.id);
    for (const id of ids) expect(await ruleSetOf(id)).toBe(set.id);
    await moveRulesBatch(api, ids, null);
    for (const id of ids) expect(await ruleSetOf(id)).toBeNull();

    const missing = "00000000-0000-4000-8000-00000000dead";
    const failure = await caught(moveRulesBatch(api, [ids[0], ids[1], missing, ids[2]], set.id));
    expect((failure as Error).message).toMatch(/^Couldn't move 4 rules:/);
    for (const id of ids) expect(await ruleSetOf(id)).toBeNull();
  });

  it("clearing by PATCH works on a published rule and opens no draft", async () => {
    const set = await newSet();
    const rule = await newRule(true);
    await moveRulesBatch(api, [rule.ruleId], set.id);
    expect(await ruleSetOf(rule.ruleId)).toBe(set.id);
    await moveRulesBatch(api, [rule.ruleId], null);
    expect(await ruleSetOf(rule.ruleId)).toBeNull();

    const drafts = await api.retrieveMultipleRecords(ENTITY_SET.rule, `?$select=asx_ruleid&$filter=_asx_draftof_value eq ${rule.ruleId}`);
    expect(drafts.entities).toEqual([]);
    const row = await api.retrieveRecord(ENTITY_SET.rule, rule.ruleId, "?$select=statuscode");
    expect(row.statuscode).toBe(753840000); // still Published
  });

  it("import stamps last-imported", async () => {
    const set = await newSet();
    const rule = await newRule(true);
    await moveRulesBatch(api, [rule.ruleId], set.id);
    const before = await api.retrieveRecord(ENTITY_SET.ruleSet, set.id, "?$select=asx_lastimportedfrom,asx_lastimportedon");
    expect(before.asx_lastimportedfrom ?? null).toBeNull();

    const exported = await user.request("POST", "asx_ExportRule", { RuleId: rule.ruleId });
    expect(exported.ok, exported.text).toBe(true);
    const source = "https://source.example.test";
    const imported = await user.request("POST", "asx_ImportRule", {
      Entry: exported.json.Entry, SourceEnvironment: source, OverwriteTargetChanges: true,
    });
    expect(imported.ok, imported.text).toBe(true);

    const stamped = await api.retrieveRecord(ENTITY_SET.ruleSet, set.id, "?$select=asx_lastimportedfrom,asx_lastimportedon");
    expect(stamped.asx_lastimportedfrom).toBe(source);
    expect(stamped.asx_lastimportedon).toBeTruthy();

    // A ValidateOnly run writes nothing, so the stamp is untouched.
    const dry = await user.request("POST", "asx_ImportRule", {
      Entry: exported.json.Entry, SourceEnvironment: "https://other.example.test", ValidateOnly: true, OverwriteTargetChanges: true,
    });
    expect(dry.ok, dry.text).toBe(true);
    const after = await api.retrieveRecord(ENTITY_SET.ruleSet, set.id, "?$select=asx_lastimportedfrom,asx_lastimportedon");
    expect(after.asx_lastimportedfrom).toBe(stamped.asx_lastimportedfrom);
    expect(after.asx_lastimportedon).toBe(stamped.asx_lastimportedon);
  });

  // SKIP(no Reader identity in the dev org, rule-sets-first-class Task 10, expires: 2027-01-31)
  it.skip("a Reader's rule set write is refused (no Reader identity in the dev org)", async () => {
    // devOrg offers only "user" and "authorSp"; add a Reader identity, then assert the 403 here.
  });
});
