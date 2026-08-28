import { createDevApi, deleteDevRecord } from "../devApi";
import { ENTITY_SET } from "../../src/editor/load/odata";

// Deletes every ZZ_RB_-prefixed row in `entitySet` whose `nameField` starts with the prefix. The
// primary id attribute is always returned by Dataverse regardless of $select, so a plain
// name-only $select is enough to recover it (same heuristic as bindNav.dev.test.ts's seededId:
// the one remaining "...id" key that isn't a "_..._value" lookup).
async function sweepSet(entitySet: string, nameField: string): Promise<void> {
  const api = createDevApi();
  // "Copy of ZZ_RB_…": the hub-duplicate e2e clones a ZZ_RB_ rule under a "Copy of "
  // name: a crash between Duplicate and its cleanup would otherwise orphan it forever.
  const filter =
    `startswith(${nameField},'ZZ_RB_') or startswith(${nameField},'Copy of ZZ_RB_')`;
  const r = await api.retrieveMultipleRecords(
    entitySet,
    `?$filter=${filter}&$select=${nameField}`,
  );
  for (const rec of r.entities) {
    const idKey = Object.keys(rec).find((k) => k.endsWith("id") && !k.startsWith("_"));
    if (!idKey) continue;
    await deleteDevRecord(entitySet, rec[idKey] as string).catch(console.warn);
  }
}

// Crash-recovery backstop: clears stray ZZ_RB_ rows left by an interrupted authoring run, in
// dependency order so FK-restrict relationships don't block the sweep (actions/conditions/groups
// before rules; orderlines before orders; orders before customers). asx_tableconfig is
// self-referential (asx_parenttable): a few repeated passes clear it regardless of node depth,
// since each pass deletes whatever no longer has children and a restrict-blocked delete just
// waits for its child to be cleared on an earlier pass. Every individual delete is wrapped so one
// restrict-order miss never aborts the rest of the sweep.
export async function sweepRuleBehaviorOrphans(): Promise<void> {
  await sweepSet(ENTITY_SET.action, "asx_name");
  await sweepSet(ENTITY_SET.condition, "asx_name");
  await sweepSet(ENTITY_SET.group, "asx_name");
  await sweepSet(ENTITY_SET.rule, "asx_name");
  for (let pass = 0; pass < 3; pass++) {
    await sweepSet(ENTITY_SET.tableConfig, "asx_name");
  }
  await sweepSet("sample_orderlines", "sample_name");
  await sweepSet("sample_shipments", "sample_name");
  await sweepSet("sample_orders", "sample_name");
  // sample_customers is single-pass, but sample_parentcustomerid is self-referential like
  // asx_tableconfig above. A single pass is fine for today's flat customer rows, but a future
  // task that builds a parent->child customer chain would need the same multi-pass treatment
  // (a restrict-blocked child delete would otherwise survive the sweep).
  await sweepSet("sample_customers", "sample_name");
}
