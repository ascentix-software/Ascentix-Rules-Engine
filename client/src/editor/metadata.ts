import type { MetadataApi } from "./webapi";
import { parseSavedViews, type SavedView, type RawViewRow } from "./load/views";

export interface TableMeta {
  logicalName: string; displayName: string; entitySetName: string;
  primaryNameAttribute: string; primaryIdAttribute: string; isCustom: boolean;
}
export interface ColumnMeta {
  logicalName: string; displayName: string; attributeType: string;
  isValidForCreate: boolean; isValidForUpdate: boolean; isValidForRead: boolean;
  isCustom: boolean;
}
export interface OptionMeta { value: number; label: string; }
export interface RelationshipMeta {
  manyToOne: { schemaName: string; referencingAttribute: string; referencedEntity: string }[];
  oneToMany: { schemaName: string; referencingEntity: string; referencingAttribute: string }[];
}
export type ColumnContext = "create" | "update" | "read";

export interface MetadataService {
  tables(): Promise<TableMeta[]>;
  columns(table: string): Promise<ColumnMeta[]>;
  optionSet(table: string, column: string): Promise<OptionMeta[]>;
  globalOptionSet(name: string): Promise<OptionMeta[]>;
  lookupTargets(table: string, column: string): Promise<string[]>;
  booleanLabels(table: string, column: string): Promise<{ trueLabel: string; falseLabel: string }>;
  relationships(table: string): Promise<RelationshipMeta>;
  views(table: string): Promise<SavedView[]>;
}

const label = (d: any): string => d?.UserLocalizedLabel?.Label ?? "";
// Managed-property booleans (IsValidForRead/Create/Update) come back two ways:
// a bare boolean when $select-projected (what the Attributes query here gets),
// or a { Value } ManagedProperty object otherwise. Handle both.
const flag = (v: any): boolean => (v && typeof v === "object" ? !!v.Value : !!v);

const PICKLIST_CAST: Record<string, string> = {
  Picklist: "PicklistAttributeMetadata",
  Status: "StatusAttributeMetadata",
  State: "StateAttributeMetadata",
  Virtual: "MultiSelectPicklistAttributeMetadata",
};

export function columnsForContext(cols: ColumnMeta[], ctx: ColumnContext): ColumnMeta[] {
  return cols.filter((c) =>
    ctx === "create" ? c.isValidForCreate : ctx === "update" ? c.isValidForUpdate : c.isValidForRead,
  );
}

export function createMetadataService(api: MetadataApi): MetadataService {
  let tablesCache: Promise<TableMeta[]> | null = null;
  const columnsCache = new Map<string, Promise<ColumnMeta[]>>();
  const optionCache = new Map<string, Promise<OptionMeta[]>>();
  const globalCache = new Map<string, Promise<OptionMeta[]>>();
  const lookupCache = new Map<string, Promise<string[]>>();
  const boolCache = new Map<string, Promise<{ trueLabel: string; falseLabel: string }>>();
  const relCache = new Map<string, Promise<RelationshipMeta>>();
  const viewsCache = new Map<string, Promise<SavedView[]>>();
  const SYSTEM_ENTITIES = new Set([
    "systemuser", "team", "businessunit", "owner", "organization",
    "transactioncurrency", "asyncoperation", "bulkdeletefailure",
    "principalobjectattributeaccess", "processsession", "sla", "slakpiinstance",
    "mailboxtrackingfolder", "syncerror", "duplicaterecord",
  ]);

  function columns(table: string): Promise<ColumnMeta[]> {
    let p = columnsCache.get(table);
    if (!p) {
      p = api
        .fetchJson(
          `EntityDefinitions(LogicalName='${table}')/Attributes` +
            "?$select=LogicalName,AttributeType,IsValidForCreate,IsValidForUpdate,IsValidForRead,IsCustomAttribute,DisplayName",
        )
        .then((r) =>
          (r.value as any[]).map((a) => ({
            logicalName: a.LogicalName,
            displayName: label(a.DisplayName) || a.LogicalName,
            attributeType: a.AttributeType,
            isValidForCreate: flag(a.IsValidForCreate),
            isValidForUpdate: flag(a.IsValidForUpdate),
            isValidForRead: flag(a.IsValidForRead),
            isCustom: flag(a.IsCustomAttribute),
          })),
        );
      columnsCache.set(table, p);
    }
    return p;
  }

  return {
    tables() {
      if (!tablesCache) {
        tablesCache = api
          .fetchJson("EntityDefinitions?$select=LogicalName,EntitySetName,DisplayName,PrimaryNameAttribute,PrimaryIdAttribute,IsCustomEntity")
          .then((r) =>
            (r.value as any[]).map((e) => ({
              logicalName: e.LogicalName,
              displayName: label(e.DisplayName) || e.LogicalName,
              entitySetName: e.EntitySetName,
              primaryNameAttribute: e.PrimaryNameAttribute,
              primaryIdAttribute: e.PrimaryIdAttribute,
              isCustom: flag(e.IsCustomEntity),
            })),
          );
      }
      return tablesCache;
    },
    columns,
    optionSet(table, column) {
      const key = `${table}.${column}`;
      let p = optionCache.get(key);
      if (!p) {
        p = columns(table).then((cols) => {
          const meta = cols.find((c) => c.logicalName === column);
          const cast = meta ? PICKLIST_CAST[meta.attributeType] : undefined;
          if (!cast) return [];
          return api
            .fetchJson(
              `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')` +
                `/Microsoft.Dynamics.CRM.${cast}?$select=LogicalName&$expand=OptionSet($select=Options)`,
            )
            .then((r) => {
              const options = r?.OptionSet?.Options ?? [];
              return (options as any[]).map((o) => ({ value: o.Value, label: label(o.Label) }));
            });
        });
        optionCache.set(key, p);
      }
      return p;
    },
    globalOptionSet(name) {
      let p = globalCache.get(name);
      if (!p) {
        p = api
          .fetchJson(
            `GlobalOptionSetDefinitions(Name='${name}')` +
              "/Microsoft.Dynamics.CRM.OptionSetMetadata?$select=Options",
          )
          .then((r) => {
            const options = r?.Options ?? [];
            return (options as any[]).map((o) => ({ value: o.Value, label: label(o.Label) }));
          });
        globalCache.set(name, p);
      }
      return p;
    },
    lookupTargets(table, column) {
      const key = `${table}.${column}`;
      let p = lookupCache.get(key);
      if (!p) {
        p = api
          .fetchJson(
            `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')` +
              "/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=Targets",
          )
          .then((r) => (r?.Targets as string[]) ?? []);
        lookupCache.set(key, p);
      }
      return p;
    },
    booleanLabels(table, column) {
      const key = `${table}.${column}`;
      let p = boolCache.get(key);
      if (!p) {
        p = api
          .fetchJson(
            `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')` +
              "/Microsoft.Dynamics.CRM.BooleanAttributeMetadata?$select=LogicalName&$expand=OptionSet",
          )
          .then((r) => ({
            trueLabel: label(r?.OptionSet?.TrueOption?.Label) || "True",
            falseLabel: label(r?.OptionSet?.FalseOption?.Label) || "False",
          }));
        boolCache.set(key, p);
      }
      return p;
    },
    relationships(table) {
      let p = relCache.get(table);
      if (!p) {
        p = Promise.all([
          api.fetchJson(`EntityDefinitions(LogicalName='${table}')/ManyToOneRelationships` +
            "?$select=SchemaName,ReferencingAttribute,ReferencedEntity"),
          api.fetchJson(`EntityDefinitions(LogicalName='${table}')/OneToManyRelationships` +
            "?$select=SchemaName,ReferencingEntity,ReferencingAttribute"),
        ]).then(([m, o]) => ({
          manyToOne: ((m?.value as any[]) ?? [])
            .filter((r) => !SYSTEM_ENTITIES.has(r.ReferencedEntity))
            .map((r) => ({ schemaName: r.SchemaName, referencingAttribute: r.ReferencingAttribute, referencedEntity: r.ReferencedEntity })),
          oneToMany: ((o?.value as any[]) ?? [])
            .filter((r) => !SYSTEM_ENTITIES.has(r.ReferencingEntity))
            .map((r) => ({ schemaName: r.SchemaName, referencingEntity: r.ReferencingEntity, referencingAttribute: r.ReferencingAttribute })),
        }));
        relCache.set(table, p);
      }
      return p;
    },
    views(table) {
      let p = viewsCache.get(table);
      if (!p) {
        p = (async () => {
          const cols = await columns(table);
          const displayNameOf = (logical: string) =>
            cols.find((c) => c.logicalName === logical)?.displayName ?? logical;
          const esc = table.replace(/'/g, "''");
          const system = await api
            .fetchJson(`savedqueries?$select=name,fetchxml,layoutjson,savedqueryid,isdefault` +
              `&$filter=returnedtypecode eq '${esc}' and querytype eq 0`)
            .then((r) => (r.value as any[]) ?? []).catch(() => []);
          const personal = await api
            .fetchJson(`userqueries?$select=name,fetchxml,layoutjson,userqueryid` +
              `&$filter=returnedtypecode eq '${esc}'`)
            .then((r) => (r.value as any[]) ?? []).catch(() => []);
          const rows: RawViewRow[] = [
            ...system.map((v) => ({ id: v.savedqueryid, name: v.name, fetchXml: v.fetchxml,
              layoutjson: v.layoutjson ?? null, isDefault: !!v.isdefault, isPersonal: false })),
            ...personal.map((v) => ({ id: v.userqueryid, name: v.name, fetchXml: v.fetchxml,
              layoutjson: v.layoutjson ?? null, isDefault: false, isPersonal: true })),
          ];
          return parseSavedViews(rows, displayNameOf);
        })();
        viewsCache.set(table, p);
      }
      return p;
    },
  };
}
