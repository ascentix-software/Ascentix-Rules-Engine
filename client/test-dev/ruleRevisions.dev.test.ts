import { expect, it } from "vitest";
import { createThrowawayRule } from "../e2e/devHelpers";
import { createDevApi, runRules, updateDevRecord } from "./devApi";
import { loadPublishedGraph } from "../src/editor/load/publishedGraph";

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
    const actionId = first.actions[0].id;
    const liveMessage = first.actions[0].message;
    expect(await messages()).toContain(liveMessage);

    await updateDevRecord("asx_ruleactions", actionId, { asx_message: "" });
    const invalid = await api.validateRule(fixture.ruleId);
    expect(invalid.isValid).toBe(false);
    await expect(api.publishRule(fixture.ruleId, (await header())["@odata.etag"], invalid.draftHash)).rejects.toThrow();
    expect((await header()).asx_publishedversion).toBe(1);
    expect(await messages()).toContain(liveMessage);

    const nextMessage = "Published revision two " + fixture.ruleId;
    await updateDevRecord("asx_ruleactions", actionId, { asx_message: nextMessage });
    const valid = await api.validateRule(fixture.ruleId);
    expect(valid.isValid).toBe(true);
    await updateDevRecord("asx_tableconfigs", first.rule.rootTableConfigId!, { asx_name: "ZZ_RB_model_changed_after_validation" });
    await expect(api.publishRule(fixture.ruleId, (await header())["@odata.etag"], valid.draftHash)).rejects.toThrow(/changed after validation/);
    expect((await published()).actions[0].message).toBe(liveMessage);
    expect(await messages()).toContain(liveMessage);

    const revalidated = await api.validateRule(fixture.ruleId);
    await api.publishRule(fixture.ruleId, (await header())["@odata.etag"], revalidated.draftHash);
    expect((await header()).asx_publishedversion).toBe(2);
    expect((await header()).statuscode).toBe(753840000);
    expect(await messages()).toContain(nextMessage);
    expect(await messages()).not.toContain(liveMessage);
  } finally {
    await fixture.cleanup();
  }
});
