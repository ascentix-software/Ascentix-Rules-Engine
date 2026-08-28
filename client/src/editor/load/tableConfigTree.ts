import type { WebApiPort } from "../webapi";
import type { TableConfigRef } from "../model/types";
import { mapTableConfig } from "./mappers";
import { ENTITY, LOOKUP, TABLECONFIG_SELECT } from "./odata";

const MAX_DEPTH = 25;

// Loads the full table-config tree rooted at `rootId` by walking asx_parenttable
// downward (BFS). Shareable trees are fine; the seen-guard dedupes and prevents
// cycles from looping. Throws if the tree is implausibly deep.
export async function loadTableConfigTree(
  api: WebApiPort, rootId: string,
): Promise<Record<string, TableConfigRef>> {
  const map: Record<string, TableConfigRef> = {};
  const root = mapTableConfig(await api.retrieveRecord(ENTITY.tableConfig, rootId, "?$select=" + TABLECONFIG_SELECT));
  map[root.id] = root;

  let frontier = [root.id];
  let depth = 0;
  while (frontier.length > 0) {
    if (++depth > MAX_DEPTH)
      throw new Error("Table-config tree exceeds max depth: possible asx_parenttable cycle.");
    const filter = frontier.map((id) => `${LOOKUP.parentTableOfConfig} eq ${id}`).join(" or ");
    const resp = await api.retrieveMultipleRecords(
      ENTITY.tableConfig, `?$select=${TABLECONFIG_SELECT}&$filter=${filter}`,
    );
    const next: string[] = [];
    for (const raw of resp.entities) {
      const tc = mapTableConfig(raw);
      if (!map[tc.id]) { map[tc.id] = tc; next.push(tc.id); }
    }
    frontier = next;
  }
  return map;
}
