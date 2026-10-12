import { devOrg } from "./devOrg";

// asx_BulkWrites ships off (Microsoft doesn't support bulk messages in plug-in code). A test that must
// exercise the engine's CreateMultiple / UpdateMultiple path turns it on for its own duration and puts it
// back exactly: the previous value row's value, or no value row when there was none. Each plug-in worker
// re-reads the switch at most once a minute, so the switch takes up to a minute to apply either way.
export const SWITCH_SETTLE_MS = 65_000;

export async function setBulkWrites(on: boolean): Promise<() => Promise<void>> {
  const org = devOrg("user");
  const def = (await org.request("GET",
    "environmentvariabledefinitions?$select=environmentvariabledefinitionid&$filter=schemaname eq 'asx_BulkWrites'")).json?.value?.[0];
  if (!def) throw new Error("asx_BulkWrites is not defined on this org: deploy the Schema phase (Configure-RuleAuthoring.ps1).");
  const values = (await org.request("GET",
    `environmentvariablevalues?$select=environmentvariablevalueid,value&$filter=_environmentvariabledefinitionid_value eq ${def.environmentvariabledefinitionid}`)).json?.value ?? [];
  if (values.length > 1) throw new Error("asx_BulkWrites has more than one value row; fix it by hand first.");
  const wanted = on ? "yes" : "no";
  let restore: () => Promise<void>;
  if (values.length === 1) {
    const { environmentvariablevalueid: id, value: previous } = values[0];
    await patch(id, wanted);
    restore = async () => { await patch(id, previous); };
  } else {
    const created = await org.request("POST", "environmentvariablevalues", {
      value: wanted, schemaname: "asx_BulkWrites",
      "EnvironmentVariableDefinitionId@odata.bind": `/environmentvariabledefinitions(${def.environmentvariabledefinitionid})`,
    }, { Prefer: "return=representation" });
    if (!created.ok) throw new Error(`asx_BulkWrites value row could not be created (${created.status}): ${created.text}`);
    const id = created.json.environmentvariablevalueid;
    restore = async () => { await org.request("DELETE", `environmentvariablevalues(${id})`); };
  }
  return restore;

  async function patch(id: string, value: string) {
    const r = await org.request("PATCH", `environmentvariablevalues(${id})`, { value }, { "If-Match": "*" });
    if (!r.ok) throw new Error(`asx_BulkWrites could not be set (${r.status}): ${r.text}`);
  }
}
