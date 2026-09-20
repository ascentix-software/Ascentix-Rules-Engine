import { expect, it } from "vitest";
import { createThrowawayRule } from "../e2e/devHelpers";
import { createDevApi, deleteDevRecord, runRules, updateDevRecord } from "./devApi";
import { loadPublishedGraph } from "../src/editor/load/publishedGraph";

it.each([false, true])("deletes a model-linked rule and its owned graph (published=%s)", async (published) => {
  const fixture = await createThrowawayRule();
  const api = createDevApi();
  const owned: { set: string; id: string }[] = [];
  const rememberGraph = async (ruleId: string) => {
    for (const [set, key] of [["asx_conditiongroups", "asx_conditiongroupid"], ["asx_ruleactions", "asx_ruleactionid"]]) {
      const rows = await api.retrieveMultipleRecords(set, `?$select=${key}&$filter=_asx_rule_value eq ${ruleId}`);
      for (const row of rows.entities) {
        owned.push({ set, id: row[key] });
        if (set === "asx_conditiongroups") {
          const conditions = await api.retrieveMultipleRecords("asx_ruleconditions", `?$select=asx_ruleconditionid&$filter=_asx_conditiongroup_value eq ${row[key]}`);
          owned.push(...conditions.entities.map(c => ({ set: "asx_ruleconditions", id: c.asx_ruleconditionid })));
        }
      }
    }
  };
  try {
    const header = await api.retrieveRecord("asx_rules", fixture.ruleId, "?$select=_asx_roottableconfig_value");
    const sharedModel = header._asx_roottableconfig_value;
    await rememberGraph(fixture.ruleId);
    if (published) {
      const validation = await api.validateRule(fixture.ruleId);
      await api.publishRule(fixture.ruleId, header["@odata.etag"], validation.draftHash);
      const revisions = await api.retrieveMultipleRecords("asx_rulerevisions", `?$select=asx_rulerevisionid&$filter=_asx_rule_value eq ${fixture.ruleId}`);
      expect(revisions.entities.length).toBeGreaterThan(0);
      owned.push(...revisions.entities.map(r => ({ set: "asx_rulerevisions", id: r.asx_rulerevisionid })));
      const draftId = await api.openRuleDraft!(fixture.ruleId);
      owned.push({ set: "asx_rules", id: draftId });
      const draft = await api.retrieveRecord("asx_rules", draftId, "?$select=_asx_roottableconfig_value");
      owned.push({ set: "asx_tableconfigs", id: draft._asx_roottableconfig_value });
      await rememberGraph(draftId);
    }
    // Exercise the product's ordinary DELETE, before the fixture cleanup can mask leftovers.
    await deleteDevRecord("asx_rules", fixture.ruleId);
    for (const row of [{ set: "asx_rules", id: fixture.ruleId }, ...owned])
      await expect(api.retrieveRecord(row.set, row.id, "")).rejects.toThrow(/404/);
    await expect(api.retrieveRecord("asx_tableconfigs", sharedModel, "?$select=asx_name")).resolves.toBeDefined();
  } finally {
    await fixture.cleanup();
  }
});

it("deletes an empty draft without trying to update the record being deleted", async () => {
  const api = createDevApi();
  const id = await api.createRecord("asx_rules", {
    asx_name: "ZZ_RB_empty_draft_" + Date.now(), asx_tablelogicalname: "account", asx_triggers: "3",
  });
  await deleteDevRecord("asx_rules", id);
  await expect(api.retrieveRecord("asx_rules", id, "?$select=asx_name")).rejects.toThrow(/404/);
});

it("keeps execution on the published revision through invalid edits and stale publication", async () => {
  const fixture = await createThrowawayRule();
  const api = createDevApi();
  const header = () => api.retrieveRecord("asx_rules", fixture.ruleId, "?$select=statuscode,asx_publishedversion");
  const published = async () => loadPublishedGraph(await api.readPublishedRule!(fixture.ruleId), fixture.ruleId);
  const messages = async () => (await runRules("account", { recordJson: JSON.stringify({ revenue: 100 }), triggers: "Manual" }))
    .firedActions.filter(a => a.ruleId === fixture.ruleId).map(a => a.message);
  try {
    const initial = await api.validateRule(fixture.ruleId);
    await api.publishRule(fixture.ruleId, (await header())["@odata.etag"], initial.draftHash);
    const first = await published();
    const liveMessage = first.actions[0].message;
    expect(await messages()).toContain(liveMessage);

    const [draftId, concurrentDraftId] = await Promise.all([
      api.openRuleDraft!(fixture.ruleId), api.openRuleDraft!(fixture.ruleId),
    ]);
    expect(draftId).not.toBe(fixture.ruleId);
    expect(concurrentDraftId).toBe(draftId);
    const draftHeader = () => api.retrieveRecord("asx_rules", draftId, "?$select=statuscode,_asx_roottableconfig_value");
    const actions = await api.retrieveMultipleRecords("asx_ruleactions", `?$select=asx_ruleactionid&$filter=_asx_rule_value eq ${draftId}`);
    const actionId = actions.entities[0].asx_ruleactionid;
    await expect(updateDevRecord("asx_ruleactions", first.actions[0].id, { asx_message: "Direct edit" })).rejects.toThrow(/working draft/);

    await updateDevRecord("asx_ruleactions", actionId, { asx_message: "" });
    const invalid = await api.validateRule(draftId);
    expect(invalid.isValid).toBe(false);
    await expect(api.publishRule(draftId, (await draftHeader())["@odata.etag"], invalid.draftHash)).rejects.toThrow();
    expect((await header()).asx_publishedversion).toBe(1);
    expect(await messages()).toContain(liveMessage);

    const nextMessage = "Published revision two " + fixture.ruleId;
    await updateDevRecord("asx_ruleactions", actionId, { asx_message: nextMessage });
    const valid = await api.validateRule(draftId);
    expect(valid.isValid).toBe(true);
    const beforeModelChange = (await draftHeader())["@odata.etag"];
    await updateDevRecord("asx_tableconfigs", (await draftHeader())._asx_roottableconfig_value, { asx_name: "ZZ_RB_model_changed_after_validation" });
    await expect(api.restoreRuleDraft!(draftId, beforeModelChange)).rejects.toThrow(/changed elsewhere/);
    await expect(api.publishRule(draftId, (await draftHeader())["@odata.etag"], valid.draftHash)).rejects.toThrow(/changed after validation/);
    expect((await published()).actions[0].message).toBe(liveMessage);
    expect(await messages()).toContain(liveMessage);

    const revalidated = await api.validateRule(draftId);
    await api.publishRule(draftId, (await draftHeader())["@odata.etag"], revalidated.draftHash);
    expect((await header()).asx_publishedversion).toBe(2);
    expect((await header()).statuscode).toBe(753840000);
    expect(await messages()).toContain(nextMessage);
    expect(await messages()).not.toContain(liveMessage);
    expect((await draftHeader()).statuscode).toBe(1);
    await updateDevRecord("asx_ruleactions", actionId, { asx_message: "Discard this" });
    await api.restoreRuleDraft!(draftId, (await draftHeader())["@odata.etag"]);
    expect((await published()).actions[0].message).toBe(nextMessage);
    expect(await messages()).toContain(nextMessage);

    await api.unpublishRule(fixture.ruleId, (await header())["@odata.etag"]);
    expect(await messages()).toEqual([]);
    await expect(api.publishRule(fixture.ruleId, (await header())["@odata.etag"])).rejects.toThrow(/working draft/);
    const restored = await api.validateRule(draftId);
    await api.publishRule(draftId, (await draftHeader())["@odata.etag"], restored.draftHash);
    expect((await header()).asx_publishedversion).toBe(3);
    expect(await messages()).toContain(nextMessage);
  } finally {
    await fixture.cleanup();
  }
});
