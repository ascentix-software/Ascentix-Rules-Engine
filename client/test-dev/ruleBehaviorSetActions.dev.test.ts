import { describe, it, beforeAll, afterEach, afterAll, expect } from "vitest";
import { createDevApi, deleteDevRecord, updateDevRecord, runRules, applyRules } from "./devApi";
import { devOrg } from "./devOrg";
import { ENTITY_SET } from "../src/editor/load/odata";
import { ensureAccountSetConfig, authorRule, type AuthoredRule } from "./ruleBehavior/authoring";
import { createSubject, expectBlockedOnUpdate } from "./ruleBehavior/subjects";
import { sweepRuleBehaviorOrphans } from "./ruleBehavior/sweep";
import { configsVisible } from "./ruleBehavior/settle";
import { setBulkWrites, SWITCH_SETTLE_MS } from "./bulkWritesSwitch";

// Spec §1.1 on DEV: an account rule keeps its contacts and their follow-up tasks in step with credit hold.
const STAMP = Date.now();
const SUBJECT = `ZZ_RB_set_${STAMP} Credit hold follow-up`; // "like" matches as a substring in memory: no wildcards
let cfg: Awaited<ReturnType<typeof ensureAccountSetConfig>>;
let rule: AuthoredRule;
const cleanups: Array<() => Promise<void>> = [];
const api = createDevApi();

// Names carry the ZZ_RB_ prefix and this run's STAMP, like every other rule-behavior fixture, so
// sweepRuleBehaviorOrphans-style tooling (and a human in Advanced Find) can recognise leftovers —
// account/contact aren't in sweep.ts's own table list, so a crashed run's rows have to be
// findable by name alone.
// telephone1 is always non-empty: DEV has a live, user-owned published rule ("Account must have a
// phone number") that Blocks an account save when it's blank. It is not test data and is never
// changed — every account this suite creates or updates keeps a non-empty telephone1 instead.
const PHONE = "555-0100";

async function account(suffix: string): Promise<string> {
  const id = await createSubject("accounts", { name: `ZZ_RB_set_${STAMP}_${suffix}`, creditonhold: false, telephone1: PHONE });
  cleanups.push(() => deleteDevRecord("accounts", id));
  return id;
}
async function contact(accountId: string, suffix: string, active = true): Promise<string> {
  const id = await createSubject("contacts", { lastname: `ZZ_RB_set_${STAMP}_${suffix}`, donotbulkemail: false,
    "parentcustomerid_account@odata.bind": `/accounts(${accountId})` });
  if (!active) await updateDevRecord("contacts", id, { statecode: 1, statuscode: 2 });
  cleanups.push(() => deleteDevRecord("contacts", id));
  return id;
}
async function followUps(contactIds: string[]): Promise<any[]> {
  const filter = contactIds.map((c) => `_regardingobjectid_value eq ${c}`).join(" or ");
  return (await api.retrieveMultipleRecords("tasks", `?$select=activityid,subject,statecode,statuscode&$filter=(${filter})`)).entities;
}

// Enforcement settle (IMPORTANT 1): the publish transaction writes the step row, but the plugin
// pipeline cache that runs it propagates asynchronously across front-end nodes (the same race
// ruleBehaviorWrite.dev.test.ts's writeObservedOnCreate settles for Create). A fresh throwaway
// account+contact is toggled on -> off each retry so a genuinely dead rule still fails, at the
// cap, rather than the first real test racing the cache.
async function settleHoldOnObserved(): Promise<boolean> {
  const accId = await createSubject("accounts", { name: `ZZ_RB_set_${STAMP}_settle_${Date.now()}`, creditonhold: false, telephone1: PHONE });
  const contactId = await createSubject("contacts", { lastname: `ZZ_RB_set_${STAMP}_settle`, donotbulkemail: false,
    "parentcustomerid_account@odata.bind": `/accounts(${accId})` });
  try {
    await updateDevRecord("accounts", accId, { creditonhold: true });
    const row = await api.retrieveRecord("contacts", contactId, "?$select=donotbulkemail");
    return row.donotbulkemail === true;
  } finally {
    const tasks = await api.retrieveMultipleRecords("tasks", `?$select=activityid&$filter=_regardingobjectid_value eq ${contactId}`)
      .catch(() => ({ entities: [] as any[] }));
    for (const t of tasks.entities) await deleteDevRecord("tasks", t.activityid).catch(() => {});
    await deleteDevRecord("contacts", contactId).catch(() => {});
    await deleteDevRecord("accounts", accId).catch(() => {});
  }
}

beforeAll(async () => {
  await sweepRuleBehaviorOrphans();
  cfg = await ensureAccountSetConfig();
  rule = await authorRule({
    name: `ZZ_RB_set_${STAMP}`, rootNodeId: cfg.account, tableLogicalName: "account", triggers: "3,4",
    conditions: [{ nodeId: cfg.account, conditionType: 1, column: "creditonhold", operator: 1, valueSource: 1, literal: "true" }],
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
    settleProbe: settleHoldOnObserved,
  });
}, 300_000);
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
afterAll(async () => { await rule?.cleanup(); await cfg?.cleanup(); });

describe("set actions on DEV (spec §1.1)", () => {
  it("hold on: updates active contacts and creates one follow-up per active contact; saving again writes nothing", async () => {
    const acc = await account("a");
    const ann = await contact(acc, "a_Ann");
    const bob = await contact(acc, "a_Bob");
    const cy = await contact(acc, "a_Cy", false);

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
    const acc = await account("b");
    const ann = await contact(acc, "b_Ann");
    const bob = await contact(acc, "b_Bob");
    await updateDevRecord("accounts", acc, { creditonhold: true });
    const [started, untouched] = await followUps([ann, bob]);
    await updateDevRecord("tasks", started.activityid, { statuscode: 3 }); // In Progress

    // IMPORTANT 4: prove the merge itself, not just its end state — updates go out before
    // deletes (§4.4), so "deactivate then delete" would land on the same end state even without
    // R6's merge rule. The dry run's ChangeSet is keyed by record, so it can only show ONE
    // outcome per row: `untouched` matches both the Deactivate's Rows filter (statecode eq 0) and
    // the Delete's Rows filter (statuscode eq 2), so with the merge it must report exactly one
    // update (`started`, deactivated) and one delete (`untouched`) — never two updates.
    const dryOff = await runRules("account", { recordId: acc, recordJson: JSON.stringify({ creditonhold: false }), triggers: "OnUpdate" });
    expect(dryOff.changeSet).toEqual({ creates: 0, updates: 1, deletes: 1, unchanged: 0 });

    await updateDevRecord("accounts", acc, { creditonhold: false });

    const after = await followUps([ann, bob]);
    expect(after.map((t) => t.activityid)).toEqual([started.activityid]);
    expect(after[0].statecode).toBe(1); // Completed (Deactivate, default status)
    // P15b: assert the untouched task's own fate — it matched both the Deactivate's Rows filter
    // and the Delete's Rows filter, and R6 says an update and a delete of the same record merge
    // into the delete, so the row itself must be gone.
    const stillThere = await api.retrieveMultipleRecords(
      "tasks", `?$select=activityid&$filter=activityid eq ${untouched.activityid}`,
    );
    expect(stillThere.entities.length).toBe(0);
  });
});

describe("set actions: Block and merge (spec §4.3/§4.4)", () => {
  // Both cases below gate on account.telephone1 rather than creditonhold, so they don't overlap
  // with the beforeAll rule's own creditonhold-gated actions on the same account/contacts config.

  it("a fired Block alongside a set action writes nothing (spec success criterion 3)", async () => {
    const acc = await account("block");
    const ann = await contact(acc, "block_Ann");
    const marker = `ZZ_RB_set_${STAMP}_BLOCK_TRIGGER`;
    const r = await authorRule({
      name: `ZZ_RB_set_block_${STAMP}`, rootNodeId: cfg.account, tableLogicalName: "account", triggers: "4",
      conditions: [{ nodeId: cfg.account, conditionType: 1, column: "telephone1", operator: 1, valueSource: 1, literal: marker }],
      actions: [
        { actionType: 4, fireOn: 1, message: `ZZ_RB_set_${STAMP} blocked` },
        { actionType: 6, fireOn: 1, targetNodeId: cfg.contacts,
          fieldMapping: JSON.stringify([{ target: "donotbulkemail", source: "literal", value: true }]),
          rowFilter: { criteria: [{ fieldName: "statecode", operator: "eq", value: "0" }] } },
      ],
    });
    try {
      await expectBlockedOnUpdate("accounts", acc, { telephone1: marker }, `ZZ_RB_set_${STAMP} blocked`);
      const after = await api.retrieveRecord("contacts", ann, "?$select=donotbulkemail");
      expect(after.donotbulkemail).toBe(false);
    } finally {
      await r.cleanup();
    }
  });

  it("two actions writing the same row merge into one update in the dry run's change set", async () => {
    const acc = await account("merge");
    await contact(acc, "merge_Ann");
    const marker = `ZZ_RB_set_${STAMP}_MERGE_TRIGGER`;
    const r = await authorRule({
      name: `ZZ_RB_set_merge_${STAMP}`, rootNodeId: cfg.account, tableLogicalName: "account", triggers: "3,4",
      conditions: [{ nodeId: cfg.account, conditionType: 1, column: "telephone1", operator: 1, valueSource: 1, literal: marker }],
      actions: [
        { actionType: 6, fireOn: 1, order: 1, targetNodeId: cfg.contacts,
          fieldMapping: JSON.stringify([{ target: "donotbulkemail", source: "literal", value: true }]),
          rowFilter: { criteria: [{ fieldName: "statecode", operator: "eq", value: "0" }] } },
        { actionType: 6, fireOn: 1, order: 2, targetNodeId: cfg.contacts,
          fieldMapping: JSON.stringify([{ target: "jobtitle", source: "literal", value: "ZZ_RB_merged" }]),
          rowFilter: { criteria: [{ fieldName: "statecode", operator: "eq", value: "0" }] } },
      ],
    });
    try {
      const dry = await runRules("account", { recordId: acc, recordJson: JSON.stringify({ telephone1: marker }), triggers: "OnUpdate" });
      expect(dry.changeSet).toEqual({ creates: 0, updates: 1, deletes: 0, unchanged: 0 });
    } finally {
      await r.cleanup();
    }
  });
});

describe("DEV probes (Task 11 unknowns)", () => {
  it("probe: UpdateMultiple accepts a statecode change on task", async () => {
    const acc = await account("p");
    const ann = await contact(acc, "p_Ann");
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

  // The engine sends bulk messages only while asx_BulkWrites is on (it ships off): both probes need the
  // bulk path, so the switch is on for this block and restored after it.
  describe("bulk path (asx_BulkWrites on)", () => {
    let restoreBulk: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      restoreBulk = await setBulkWrites(true);
      await new Promise((r) => setTimeout(r, SWITCH_SETTLE_MS));
    }, SWITCH_SETTLE_MS + 60_000);
    afterAll(async () => { await restoreBulk?.(); });

    it("probe: an engine-issued bulk UpdateMultiple write doesn't re-trigger the written table's own OnUpdate rule", async () => {
      // CRITICAL precondition: ChangeSetDispatcher only attempts UpdateMultiple while asx_BulkWrites is on
      // (it ships off), the batch has >= 2 writes AND the table supports the bulk message
      // (ChangeSetDispatcher.cs SendBatches / SdkMessageFilterBulkSupport). The switch is turned on for
      // this probe and restored in its finally. If contact doesn't support UpdateMultiple on this org, the
      // account rule's write falls back to single Updates and this probe would trivially pass
      // (or fail) without ever exercising the bulk path it exists to prove — fail loudly instead of
      // silently proving nothing.
      const supported = (await api.retrieveMultipleRecords("sdkmessagefilters",
        "?$select=sdkmessagefilterid&$filter=primaryobjecttypecode eq 'contact' and sdkmessageid/name eq 'UpdateMultiple'")).entities;
      if (supported.length === 0) {
        throw new Error(
          "probe precondition failed: UpdateMultiple is not registered for 'contact' on this org, so the " +
          "account rule's bulk write falls back to single Updates. This probe specifically proves the " +
          "engine-write tag survives the BULK UpdateMultiple path, and cannot do that here.",
        );
      }

      const tagStamp = `${STAMP}_tag`;
      const probeSubject = `${SUBJECT} tag probe`;
      const contactRootId = await api.createRecord(ENTITY_SET.tableConfig, {
        asx_name: `ZZ_RB_TC_set_contactroot_${tagStamp}`, asx_tablelogicalname: "contact", asx_tableconfigtype: 1,
      });
      // IMPORTANT 2: a freshly created asx_tableconfig row is not immediately visible to the
      // engine's id-filtered RetrieveMultiple over that table (same lag ensureTableConfig-style
      // helpers settle for via awaitConfigsVisible) — publish below would validate/register against
      // a tree that doesn't see its own root yet.
      await configsVisible([contactRootId]);
      const settleContactId = await createSubject("contacts", { lastname: `ZZ_RB_set_${tagStamp}_settle`, donotbulkemail: false });
      let tagRule: AuthoredRule | undefined;
      try {
        tagRule = await authorRule({
          name: `ZZ_RB_set_tag_${tagStamp}`, rootNodeId: contactRootId, tableLogicalName: "contact", triggers: "4",
          conditions: [{ nodeId: contactRootId, conditionType: 1, column: "donotbulkemail", operator: 1, valueSource: 1, literal: "true" }],
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

        // CRITICAL: at least TWO active contacts. ChangeSetDispatcher.SendBatches only attempts
        // UpdateMultiple at writes.Count >= 2 (ChangeSetDispatcher.cs); with a single contact the
        // account rule's write goes as an ordinary single Update regardless of whether the tag
        // survives the bulk path, so the probe couldn't fail even if that propagation were broken.
        const acc = await account("tag");
        const ann = await contact(acc, "tag_Ann");
        const bob = await contact(acc, "tag_Bob");
        await updateDevRecord("accounts", acc, { creditonhold: true }); // fires the account rule's bulk UpdateMultiple

        // Positive control: the bulk write actually happened, for both contacts.
        const afterBulk = (await api.retrieveMultipleRecords("contacts",
          `?$select=contactid,donotbulkemail&$filter=_parentcustomerid_value eq ${acc}`)).entities;
        for (const c of [ann, bob]) {
          const row = afterBulk.find((x) => x.contactid === c);
          expect(row?.donotbulkemail).toBe(true);
        }

        // The real assertion: neither contact's own OnUpdate rule fired as a side effect of the
        // bulk write that just touched it.
        for (const c of [ann, bob]) {
          const tasks = (await api.retrieveMultipleRecords("tasks",
            `?$select=activityid&$filter=_regardingobjectid_value eq ${c} and subject eq '${probeSubject}'`)).entities;
          console.log(`PROBE engine-tag propagation: tasks for contact ${c} after bulk UpdateMultiple = ${tasks.length}`);
          expect(tasks.length).toBe(0);
        }
      } finally {
        const leftoverTasks = await api.retrieveMultipleRecords(
          "tasks", `?$select=activityid&$filter=subject eq '${probeSubject}'`,
        ).catch(() => ({ entities: [] as any[] }));
        for (const t of leftoverTasks.entities) await deleteDevRecord("tasks", t.activityid).catch(() => {});
        // Cheap fix: keep cleaning up even if the rule's own cascade delete throws (e.g. a
        // mid-authoring failure left it partially built).
        try { await tagRule?.cleanup(); } catch (e) { console.warn("tagRule cleanup failed:", e); }
        await deleteDevRecord("contacts", settleContactId).catch(() => {});
        await deleteDevRecord(ENTITY_SET.tableConfig, contactRootId).catch(() => {});
      }
    }, 180_000); // IMPORTANT 3: explicit timeout — two settle rounds plus a bulk write and cleanup.

    it("probe: the engine's own CreateMultiple of tasks runs a task OnCreate rule with a server action on every task", async () => {
      // Final review Important 1: a Create per row of >= 2 contacts goes out as ONE engine-issued
      // CreateMultiple of tasks, with no ids. When task has an engine rule with an OnCreate server
      // action, that CreateMultiple runs the engine on task; pairing its records with their Targets
      // by id collided on Guid.Empty and failed the account save. The task rule here writes each
      // task's own subject into its description (an in-place root Update), so both the save
      // succeeding AND each task getting ITS OWN value are checked.
      const supported = (await api.retrieveMultipleRecords("sdkmessagefilters",
        "?$select=sdkmessagefilterid&$filter=primaryobjecttypecode eq 'task' and sdkmessageid/name eq 'CreateMultiple'")).entities;
      if (supported.length === 0) {
        throw new Error(
          "probe precondition failed: CreateMultiple is not registered for 'task' on this org, so the " +
          "account rule's creates fall back to single Creates and this probe cannot reach the bulk path.",
        );
      }

      const cmStamp = `${STAMP}_cm`;
      const marker = `ZZ_RB_set_${STAMP}`; // every follow-up subject (SUBJECT) and every probe task below carries it
      const taskRootId = await api.createRecord(ENTITY_SET.tableConfig, {
        asx_name: `ZZ_RB_TC_set_taskroot_${cmStamp}`, asx_tablelogicalname: "task", asx_tableconfigtype: 1,
      });
      await configsVisible([taskRootId]); // same lag as the tag probe's contact root
      const probeTaskIds: string[] = [];
      let contactIds: string[] = [];
      let taskRule: AuthoredRule | undefined;
      const description = async (id: string) =>
        (await api.retrieveRecord("tasks", id, "?$select=subject,description")) as { subject: string; description: string | null };
      try {
        taskRule = await authorRule({
          name: `ZZ_RB_set_cm_${cmStamp}`, rootNodeId: taskRootId, tableLogicalName: "task", triggers: "1",
          conditions: [{ nodeId: taskRootId, conditionType: 1, column: "subject", operator: 7, valueSource: 1, literal: marker }],
          actions: [{ actionType: 6, fireOn: 1, targetNodeId: taskRootId,
            fieldMapping: JSON.stringify([{ target: "description", source: "root", column: "subject" }]) }],
          // Enforcement settle: a single task create until the engine stamps its description.
          settleProbe: async () => {
            const id = await createSubject("tasks", { subject: `${marker}_cm_settle_${Date.now()}` });
            probeTaskIds.push(id);
            const row = await description(id);
            return row.description === row.subject;
          },
        });

        // A user-issued CreateMultiple with no ids reaches the same path; each task gets its own subject.
        const org = devOrg("user");
        const bulk = await org.request("POST", "tasks/Microsoft.Dynamics.CRM.CreateMultiple", {
          Targets: [1, 2].map((n) => ({ "@odata.type": "Microsoft.Dynamics.CRM.task", subject: `${marker}_cm_user_${n}` })),
        });
        console.log(`PROBE user CreateMultiple of tasks without ids: status=${bulk.status}${bulk.ok ? "" : ` ${bulk.text}`}`);
        expect(bulk.ok).toBe(true);
        const userIds: string[] = bulk.json?.Ids ?? [];
        probeTaskIds.push(...userIds);
        expect(userIds.length).toBe(2);
        for (const id of userIds) {
          const row = await description(id);
          expect(row.description).toBe(row.subject);
        }

        // The engine-issued CreateMultiple: the suite's account rule creates one follow-up per active contact.
        const acc = await account("cm");
        contactIds = [await contact(acc, "cm_Ann"), await contact(acc, "cm_Bob")];
        await updateDevRecord("accounts", acc, { creditonhold: true }); // must not fail the save

        const created = (await api.retrieveMultipleRecords("tasks",
          `?$select=activityid,subject,description&$filter=(${contactIds.map((c) => `_regardingobjectid_value eq ${c}`).join(" or ")})`)).entities;
        console.log(`PROBE engine CreateMultiple of follow-ups under a task OnCreate rule: ${created.length} task(s), ` +
          `descriptions ${created.map((t) => (t.description === t.subject ? "own" : JSON.stringify(t.description))).join(",")}`);
        expect(created.length).toBe(2);
        for (const t of created) expect(t.description).toBe(t.subject);
      } finally {
        const leftovers = contactIds.length
          ? await api.retrieveMultipleRecords("tasks",
            `?$select=activityid&$filter=(${contactIds.map((c) => `_regardingobjectid_value eq ${c}`).join(" or ")})`)
            .catch(() => ({ entities: [] as any[] }))
          : { entities: [] as any[] };
        for (const t of leftovers.entities) await deleteDevRecord("tasks", t.activityid).catch(() => {});
        for (const id of probeTaskIds) await deleteDevRecord("tasks", id).catch(() => {});
        try { await taskRule?.cleanup(); } catch (e) { console.warn("taskRule cleanup failed:", e); }
        await deleteDevRecord(ENTITY_SET.tableConfig, taskRootId).catch(() => {});
      }
    }, 180_000);
  });
});
