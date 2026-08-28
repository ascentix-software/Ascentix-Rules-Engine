import type { WebApiPort } from "./webapi";
import type { MetadataService } from "./metadata";

export interface LookupOption { id: string; name: string; }

export interface RecordRow { id: string; name: string; entity: Record<string, any>; }

export interface RecordSearchService {
  search(table: string, query: string, top?: number): Promise<LookupOption[]>;
  resolveName(tables: string[], id: string): Promise<string | null>;
  queryByFetchXml(table: string, fetchXml: string): Promise<RecordRow[]>;
}

export function buildRecordSearchOptions(primaryName: string, query: string, top: number): string {
  const q = query.trim();
  if (!q) return `?$select=${primaryName}&$top=${top}`;
  const escaped = q.replace(/'/g, "''");
  return `?$select=${primaryName}&$filter=contains(${primaryName},'${escaped}')&$top=${top}`;
}

export function createRecordSearchService(api: WebApiPort, meta: MetadataService): RecordSearchService {
  const nameCache = new Map<string, Promise<string | null>>();

  async function tableMeta(table: string) {
    const tables = await meta.tables();
    return tables.find((t) => t.logicalName === table) ?? null;
  }

  return {
    async search(table, query, top = 20) {
      const t = await tableMeta(table);
      if (!t) return [];
      const options = buildRecordSearchOptions(t.primaryNameAttribute, query, top);
      const res = await api.retrieveMultipleRecords(table, options);
      return (res.entities ?? []).map((e: any) => ({
        id: e[t.primaryIdAttribute],
        name: e[t.primaryNameAttribute] ?? e[t.primaryIdAttribute],
      }));
    },
    async queryByFetchXml(table, fetchXml) {
      const t = await tableMeta(table);
      if (!t) return [];
      const res = await api.retrieveMultipleRecords(table, "?fetchXml=" + encodeURIComponent(fetchXml));
      return (res.entities ?? []).map((e: any) => ({
        id: e[t.primaryIdAttribute],
        name: e[t.primaryNameAttribute] ?? e[t.primaryIdAttribute],
        entity: e,
      }));
    },
    resolveName(tables, id) {
      const key = id;
      let p = nameCache.get(key);
      if (!p) {
        p = (async () => {
          for (const table of tables) {
            const t = await tableMeta(table);
            if (!t) continue;
            try {
              const rec = await api.retrieveRecord(table, id, `?$select=${t.primaryNameAttribute}`);
              if (rec && rec[t.primaryNameAttribute] != null) return rec[t.primaryNameAttribute] as string;
            } catch {
              // wrong table for this id, so try the next candidate
            }
          }
          return null;
        })();
        nameCache.set(key, p);
      }
      return p;
    },
  };
}
