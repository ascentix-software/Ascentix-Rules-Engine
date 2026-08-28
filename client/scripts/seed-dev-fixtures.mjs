// Idempotent DEV seed for P2 Layer-2 contract tests.
// Persistent fixtures use the reserved prefix ZZ_P2SEED_ and are never mutated by
// read tests. Also sweeps orphaned ZZ_P2RUN_ records left by a crashed write test.
import { devOrg } from "./devOrg.mjs";

const SEED = "ZZ_P2SEED_";
const RUN = "ZZ_P2RUN_";

// DevOrg "user": DATAVERSE_URL from process.env / the repo-root .env; the token is the injected
// DATAVERSE_TOKEN (Tier-C runner seam) or the az user mint (scripts/devOrg.mjs).
const org = devOrg("user");

async function get(path) {
  const r = await org.request("GET", path);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${r.text}`);
  return r.json;
}
const post = (set, data) => org.api.createRecord(set, data);
const del = (set, id) => org.deleteRecord(set, id);

// Upsert-by-name: returns existing id if a record with that name exists, else creates.
async function ensure(set, nameField, name, payload) {
  const q = encodeURIComponent(`${nameField} eq '${name}'`);
  const found = await get(`${set}?$filter=${q}&$select=${nameField}`);
  if (found.value?.length) {
    const rec = found.value[0];
    const id = rec[`${set.replace(/s$/, "")}id`] ?? rec[Object.keys(rec).find((k) => k.endsWith("id"))];
    console.log(`[skip] ${set} '${name}' ${id}`);
    return id;
  }
  const id = await post(set, { [nameField]: name, ...payload });
  console.log(`[create] ${set} '${name}' ${id}`);
  return id;
}

async function sweepOrphans() {
  // Delete stray run-prefix rules (and their config) from crashed write tests.
  for (const set of ["asx_rules", "asx_tableconfigs"]) {
    const nameField = "asx_name";
    const q = encodeURIComponent(`startswith(${nameField}, '${RUN}')`);
    const stray = await get(`${set}?$filter=${q}&$select=${nameField}`);
    for (const rec of stray.value ?? []) {
      const idKey = Object.keys(rec).find((k) => k.endsWith("id") && k !== "asx_name");
      if (idKey) { await del(set, rec[idKey]); console.log(`swept ${set} ${rec[idKey]}`); }
    }
  }
}

async function main() {
  await sweepOrphans();

  // Persistent read-seed: a root table config + a rule bound to it, rich enough for every *_SELECT.
  const rootCfg = await ensure("asx_tableconfigs", "asx_name", `${SEED}RootConfig`, {
    asx_tablelogicalname: "account", asx_tableconfigtype: 1,
  });
  const ruleId = await ensure("asx_rules", "asx_name", `${SEED}Rule`, {
    asx_tablelogicalname: "account",
    asx_triggers: "1,4",
    // BIND_NAV.ruleRootTableConfig is PascalCase "asx_RootTableConfig" (case-sensitive).
    "asx_RootTableConfig@odata.bind": `/asx_tableconfigs(${rootCfg})`,
  });
  // A group, a condition, and an action under the rule so GROUP/CONDITION/ACTION selects resolve.
  const groupId = await ensure("asx_conditiongroups", "asx_name", `${SEED}Group`, {
    asx_logicaloperator: 1, asx_isexecutioncondition: false,
    "asx_rule@odata.bind": `/asx_rules(${ruleId})`,
  });
  await ensure("asx_ruleconditions", "asx_name", `${SEED}Condition`, {
    asx_conditiontype: 1, asx_comparisoncolumn: "name",
    asx_comparisonoperator: 1, asx_comparisonvaluesource: 1, asx_comparisonvalue: "Contoso",
    "asx_conditiongroup@odata.bind": `/asx_conditiongroups(${groupId})`,
    "asx_tableconfig@odata.bind": `/asx_tableconfigs(${rootCfg})`,
  });
  await ensure("asx_ruleactions", "asx_name", `${SEED}Action`, {
    asx_actiontype: 4, asx_fireon: 1, asx_order: 1,
    "asx_rule@odata.bind": `/asx_rules(${ruleId})`,
  });

  console.log(`Seed ready. Rule ${ruleId} under prefix ${SEED}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
