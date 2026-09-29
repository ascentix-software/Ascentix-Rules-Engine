import { describe, it, beforeAll, afterEach, afterAll, expect } from "vitest";
import { createDevApi, deleteDevRecord, updateDevRecord, runRules, applyRules } from "./devApi";
import { devOrg } from "./devOrg";
import { ENTITY_SET } from "../src/editor/load/odata";
import { ensureAccountSetConfig, authorRule, type AuthoredRule } from "./ruleBehavior/authoring";
import { createSubject } from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";

// Spec §1.1 on DEV: an account rule keeps its contacts and their follow-up tasks in step with credit hold.
const STAMP = Date.now();
const SUBJECT = `ZZ_RB_set_${STAMP} Credit hold follow-up`; // "like" matches as a substring in memory: no wildcards
let cfg: Awaited<ReturnType<typeof ensureAccountSetConfig>>;
let rule: AuthoredRule;
const cleanups: Array<() => Promise<void>> = [];
const api = createDevApi();

async function account(name: string): Promise<string> {
  const id = await createSubject("accounts", { name, creditonhold: false });
  cleanups.push(() => deleteDevRecord("accounts", id));
  return id;
}
async function contact(accountId: string, name: string, active = true): Promise<string> {
  const id = await createSubject("contacts", { lastname: name, donotbulkemail: false,
    "parentcustomerid_account@odata.bind": `/accounts(${accountId})` });
  if (!active) await updateDevRecord("contacts", id, { statecode: 1, statuscode: 2 });
  cleanups.push(() => deleteDevRecord("contacts", id));
  return id;
}
async function followUps(contactIds: string[]): Promise<any[]> {
  const filter = contactIds.map((c) => `_regardingobjectid_value eq ${c}`).join(" or ");
  return (await api.retrieveMultipleRecords("tasks", `?$select=activityid,subject,statecode,statuscode&$filter=(${filter})`)).entities;
}

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  cfg = await ensureAccountSetConfig();
  rule = await authorRule({
    name: `ZZ_RB_set_${STAMP}`, rootNodeId: cfg.account, tableLogicalName: "account", triggers: "3,4",
    conditions: [{ nodeId: cfg.account, conditionType: 1, column: "creditonhold", operator: 1, literal: "true" }],
    actions: [
      { actionType: 6, fireOn: 1, order: 1, targetNodeId: cfg.contacts,
        fieldMapping: JSON.stringify([{ target: "donotbulkemail", source: "literal", value: true }]),
        rowFilter: { criteria: [{ fieldName: "statecode", operator: "eq", value: "0" }] } },
      { actionType: 5, fireOn: 1, order: 2, targetTable: "task", targetNodeId: cfg.contacts,
        fieldMapping: JSON.stringify([
          { target: "regardingobjectid", source: "row", column: "contactid" },
          { target: "subject", source: "template", template: `${SUBJECT} – {row.fullname}` }]),
        rowFilter: { criteria: [{ fieldName: "statecode", operator: "eq", value: "0" },
          { exists: { collectionNodeId: cfg.tasks, maxCount: 0, sub: [{ fieldName: "subject", operator: "like", value: SUBJECT }, { fieldName: "statecode", operator: "eq", value: "0" }] } }] } },
      { actionType: 8, fireOn: 2, order: 3, targetNodeId: cfg.tasks,
        rowFilter: { criteria: [{ fieldName: "subject", operator: "like", value: SUBJECT }, { fieldName: "statecode", operator: "eq", value: "0" }] } },
      { actionType: 7, fireOn: 2, order: 4, targetNodeId: cfg.tasks,
        rowFilter: { criteria: [{ fieldName: "subject", operator: "like", value: SUBJECT }, { fieldName: "statuscode", operator: "eq", value: "2" }] } },
    ],
  });
}, 300_000);
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
afterAll(async () => { await rule?.cleanup(); await cfg?.cleanup(); });

describe("set actions on DEV (spec §1.1)", () => {
  it("hold on: updates active contacts and creates one follow-up per active contact; saving again writes nothing", async () => {
    const acc = await account(`ZZ_RB_set_${STAMP}_a`);
    const ann = await contact(acc, "Ann");
    const bob = await contact(acc, "Bob");
    const cy = await contact(acc, "Cy", false);

    await updateDevRecord("accounts", acc, { creditonhold: true });

    const contacts = (await api.retrieveMultipleRecords("contacts", `?$select=contactid,donotbulkemail&$filter=_parentcustomerid_value eq ${acc}`)).entities;
    expect(contacts.find((c) => c.contactid === ann).donotbulkemail).toBe(true);
    expect(contacts.find((c) => c.contactid === bob).donotbulkemail).toBe(true);
    expect(contacts.find((c) => c.contactid === cy).donotbulkemail).toBe(false);
    expect((await followUps([ann, bob, cy])).length).toBe(2);

    const dry = await runRules("account", { recordId: acc, triggers: "OnUpdate" });
    expect(dry.changeSet).toEqual({ creates: 0, updates: 0, deletes: 0, unchanged: 2 });

    const applied = await applyRules(rule.ruleId, acc);
    expect(applied.writeCount).toBe(0);
    expect((await followUps([ann, bob, cy])).length).toBe(2);
  });

  it("hold off: completes the started follow-up and deletes the one nobody started (merged delete)", async () => {
    const acc = await account(`ZZ_RB_set_${STAMP}_b`);
    const ann = await contact(acc, "Ann");
    const bob = await contact(acc, "Bob");
    await updateDevRecord("accounts", acc, { creditonhold: true });
    const [started, untouched] = await followUps([ann, bob]);
    await updateDevRecord("tasks", started.activityid, { statuscode: 3 }); // In Progress

    await updateDevRecord("accounts", acc, { creditonhold: false });

    const after = await followUps([ann, bob]);
    expect(after.map((t) => t.activityid)).toEqual([started.activityid]);
    expect(after[0].statecode).toBe(1); // Completed (Deactivate, default status)
    // P15b: assert the untouched task's own fate — it matched both the Deactivate's Rows filter
    // (statecode eq 0) and the Delete's Rows filter (statuscode eq 2), and R6 says an update and
    // a delete of the same record merge into the delete, so the row itself must be gone.
    const stillThere = await api.retrieveMultipleRecords(
      "tasks", `?$select=activityid&$filter=activityid eq ${untouched.activityid}`,
    );
    expect(stillThere.entities.length).toBe(0);
  });
});

describe("DEV probes (Task 11 unknowns)", () => {
  it("probe: UpdateMultiple accepts a statecode change on task", async () => {
    const acc = await account(`ZZ_RB_set_${STAMP}_p`);
    const ann = await contact(acc, "Ann");
    const ids: string[] = [];
    for (const n of [1, 2]) ids.push(await createSubject("tasks", { subject: `ZZ_RB_set_${STAMP}_probe_${n}`,
      "regardingobjectid_contact@odata.bind": `/contacts(${ann})` }));
    const org = devOrg("user");
    const r = await org.request("POST", "tasks/Microsoft.Dynamics.CRM.UpdateMultiple", {
      Targets: ids.map((id) => ({ "@odata.type": "Microsoft.Dynamics.CRM.task", activityid: id, statecode: 1, statuscode: 5 })),
    });
    const states = await Promise.all(ids.map((id) => api.retrieveRecord("tasks", id, "?$select=statecode")));
    console.log(`PROBE UpdateMultiple+statecode: status=${r.status} states=${states.map((s) => s.statecode).join(",")}`);
    expect(r.ok).toBe(true);
    expect(states.every((s) => s.statecode === 1)).toBe(true);
  });

  it("probe: sdkmessagefilter answers CreateMultiple/UpdateMultiple support for task and contact", async () => {
    for (const [message, table] of [["CreateMultiple", "task"], ["UpdateMultiple", "task"], ["UpdateMultiple", "contact"]]) {
      const rows = (await api.retrieveMultipleRecords("sdkmessagefilters",
        `?$select=sdkmessagefilterid&$filter=primaryobjecttypecode eq '${table}' and sdkmessageid/name eq '${message}'`)).entities;
      console.log(`PROBE ${message} ${table}: ${rows.length > 0 ? "supported" : "not supported"}`);
    }
  });

  it("probe: an engine-issued bulk UpdateMultiple write doesn't re-trigger the written table's own OnUpdate rule", async () => {
    // R6/§4.4: the account rule above writes donotbulkemail on its contacts through a bulk
    // UpdateMultiple (ChangeSetDispatcher). Those writes carry the engine's own "this write came
    // from the engine" tag so the rule below — a genuine, independent OnUpdate rule rooted on
    // contact itself, gated on donotbulkemail — does not fire as a side effect of them. If the
    // tag doesn't propagate through the bulk path the way it does for a single Update, this rule
    // fires for every contact the bulk write touches and leaves a task nobody asked for.
    const tagStamp = `${STAMP}_tag`;
    const probeSubject = `${SUBJECT} tag probe`;
    const contactRootId = await api.createRecord(ENTITY_SET.tableConfig, {
      asx_name: `ZZ_RB_TC_set_contactroot_${tagStamp}`, asx_tablelogicalname: "contact", asx_tableconfigtype: 1,
    });
    const settleContactId = await createSubject("contacts", { lastname: `ZZ_RB_set_${tagStamp}_settle`, donotbulkemail: false });
    let tagRule: AuthoredRule | undefined;
    try {
      tagRule = await authorRule({
        name: `ZZ_RB_set_tag_${tagStamp}`, rootNodeId: contactRootId, tableLogicalName: "contact", triggers: "4",
        conditions: [{ nodeId: contactRootId, conditionType: 1, column: "donotbulkemail", operator: 1, literal: "true" }],
        actions: [{ actionType: 5, fireOn: 1, targetTable: "task",
          fieldMapping: JSON.stringify([
            { target: "subject", source: "literal", value: probeSubject },
            { target: "regardingobjectid", source: "ref", node: contactRootId },
          ]) }],
        // Enforcement settle: toggle the throwaway contact directly until its own OnUpdate save
        // produces the probe task, so the bulk-write scenario below runs against a genuinely
        // live step rather than a false "no task" from the step cache not having caught up yet.
        settleProbe: async () => {
          await updateDevRecord("contacts", settleContactId, { donotbulkemail: true });
          const tasks = (await api.retrieveMultipleRecords("tasks",
            `?$select=activityid&$filter=_regardingobjectid_value eq ${settleContactId} and subject eq '${probeSubject}'`)).entities;
          if (tasks.length > 0) return true;
          await updateDevRecord("contacts", settleContactId, { donotbulkemail: false });
          return false;
        },
      });

      const acc = await account(`ZZ_RB_set_${STAMP}_tag`);
      const ann = await contact(acc, "AnnTag");
      await updateDevRecord("accounts", acc, { creditonhold: true }); // fires the account rule's bulk UpdateMultiple

      const tasks = (await api.retrieveMultipleRecords("tasks",
        `?$select=activityid&$filter=_regardingobjectid_value eq ${ann} and subject eq '${probeSubject}'`)).entities;
      console.log(`PROBE engine-tag propagation: tasks after bulk UpdateMultiple = ${tasks.length}`);
      expect(tasks.length).toBe(0);
    } finally {
      const leftoverTasks = await api.retrieveMultipleRecords(
        "tasks", `?$select=activityid&$filter=subject eq '${probeSubject}'`,
      ).catch(() => ({ entities: [] as any[] }));
      for (const t of leftoverTasks.entities) await deleteDevRecord("tasks", t.activityid).catch(() => {});
      await tagRule?.cleanup();
      await deleteDevRecord("contacts", settleContactId).catch(() => {});
      await deleteDevRecord(ENTITY_SET.tableConfig, contactRootId).catch(() => {});
    }
  });
});
