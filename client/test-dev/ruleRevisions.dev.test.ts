import { expect, it } from "vitest";
import { createThrowawayRule } from "../e2e/devHelpers";
import { createDevApi, deleteDevRecord, runRules, updateDevRecord } from "./devApi";
import { loadPublishedGraph } from "../src/editor/load/publishedGraph";

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
