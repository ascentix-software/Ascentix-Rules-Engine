import { parseDryRun, type DryRunResult } from "./runs/dryRunFormat";

/** Parsed issue returned by the asx_ValidateRule Custom API. */
export interface ApiIssue {
  severity: string;
  code: string;
  message: string;
  target: { kind: string; id: string; field?: string };
}

/** Camel-cased outputs of the asx_ProcessRunPage Custom API (docs/Schema.md §7). */
export interface RunPageResult {
  done: boolean;
  status: number;
  evaluated: number;
  changed: number;
  blocked: number;
  failed: number;
  skipped: number;
}
/** A data update the environment still needs (asx_ApplyDataUpdates `Pending`, docs/Schema.md §10). */
export interface DataUpdateRef { number: number; title: string; }
/** The last-touched data update (asx_ApplyDataUpdates `Latest`). */
export interface DataUpdateReport {
  number: number; title: string; status: number; succeeded: number; failed: number;
  failures: { item: string; message: string }[];
}
/** Camel-cased outputs of the asx_ApplyDataUpdates Custom API. */
export interface DataUpdateStatus {
  required: number; pending: DataUpdateRef[]; latest: DataUpdateReport | null; canApply: boolean; done: boolean;
}
/** asx_dataupdate.asx_status values. */
export const DATA_UPDATE_STATUS = { Running: 1, Completed: 2, CompletedWithFailures: 3 } as const;

export function parseDataUpdateStatus(raw: any): DataUpdateStatus {
  const pending = raw?.Pending ? JSON.parse(raw.Pending) : [];
  const latest = raw?.Latest ? JSON.parse(raw.Latest) : null;
  return {
    required: raw?.Required ?? 0,
    pending: Array.isArray(pending) ? pending : [],
    latest: latest ?? null,
    canApply: !!raw?.CanApply,
    done: !!raw?.Done,
  };
}

// Thin port over the read operations the editor needs. All editor load logic
// depends on this interface, never on Xrm directly, so it is mockable in tests.
export interface WebApiPort {
  retrieveRecord(entity: string, id: string, options?: string): Promise<any>;
  retrieveMultipleRecords(entity: string, options?: string): Promise<{ entities: any[] }>;
  createRecord(entity: string, data: Record<string, any>): Promise<string>;
  updateRecord(entitySet: string, id: string, data: Record<string, unknown>): Promise<void>;
  /** Call asx_ProcessRunPage and return the camel-cased result (docs/Schema.md §7). */
  processRunPage(runId: string, failed?: { recordId: string; message: string }): Promise<RunPageResult>;
  /** Call asx_ValidateRule and return the parsed verdict. */
  validateRule(ruleId: string): Promise<{ isValid: boolean; issues: ApiIssue[]; draftHash?: string }>;
  /** PATCH the rule's statuscode to Published (753840000). */
  publishRule(ruleId: string): Promise<void>;
  readPublishedRule?(ruleId: string): Promise<string>;
  openRuleDraft?(ruleId: string): Promise<string>;
  copyRule?(ruleId: string): Promise<string>;
  deleteRule?(ruleId: string): Promise<void>;
  restoreRuleDraft?(ruleId: string): Promise<void>;
  /** PATCH the rule's statuscode back to Draft (1), the inverse of publishRule. */
  unpublishRule(ruleId: string): Promise<void>;
  /** Call asx_RunRules (report-only) for one record and return its fired actions, change set and outcome values. */
  dryRun?(table: string, recordId: string, triggers: string): Promise<DryRunResult>;
  /** asx_ApplyDataUpdates: "Status" for anyone with rule read; "Apply" for administrators (docs/Schema.md §10). */
  applyDataUpdates?(mode: "Status" | "Apply", options?: { retry?: number; failed?: { item: string; message: string } }): Promise<DataUpdateStatus>;
}

// A full-page web resource can reach the Client API on the window or its parent.
function resolveXrm(): any {
  const w = window as any;
  if (w.Xrm && w.Xrm.WebApi) return w.Xrm;
  if (w.parent && w.parent.Xrm && w.parent.Xrm.WebApi) return w.parent.Xrm;
  throw new Error("Xrm.WebApi is not available in this context.");
}

const API_VERSION = "v9.2";

// Shared headers for a raw PATCH against the Web API (used by patchStatus and updateRecord).
const PATCH_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  Accept: "application/json",
  "OData-MaxVersion": "4.0",
  "OData-Version": "4.0",
  "If-Match": "*",
} as const;

export interface BatchApi {
  getClientUrl(): string;
  executeBatch(boundary: string, body: string): Promise<{ httpStatus: number; text: string }>;
}

export interface MetadataApi {
  getClientUrl(): string;
  fetchJson(path: string): Promise<any>;
}

export interface EditorApi extends WebApiPort, BatchApi, MetadataApi {}

function clientUrl(xrm: any): string {
  return xrm.Utility.getGlobalContext().getClientUrl();
}

export function createWebApiPort(): EditorApi {
  const xrm = resolveXrm();
  const base = clientUrl(xrm);
  return {
    retrieveRecord: (entity, id, options) => xrm.WebApi.retrieveRecord(entity, id, options),
    retrieveMultipleRecords: (entity, options) => xrm.WebApi.retrieveMultipleRecords(entity, options),
    createRecord: async (entity, data) => {
      const r = await xrm.WebApi.createRecord(entity, data);
      return String(r.id).replace(/[{}]/g, "");
    },
    async updateRecord(entitySet, id, data) {
      const res = await fetch(`${base}/api/data/${API_VERSION}/${entitySet}(${id})`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: PATCH_HEADERS,
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const raw = await res.json().catch(() => null);
        throw new Error(raw?.error?.message ?? `updateRecord PATCH failed (${res.status})`);
      }
    },
    async processRunPage(runId, failed) {
      const raw = await revisionRequest(base, "asx_ProcessRunPage", {
        RunId: runId,
        ...(failed ? { FailedRecordId: failed.recordId, FailedMessage: failed.message } : {}),
      });
      return {
        done: !!raw.Done,
        status: raw.Status,
        evaluated: raw.Evaluated,
        changed: raw.Changed,
        blocked: raw.Blocked,
        failed: raw.Failed,
        skipped: raw.Skipped,
      };
    },
    async applyDataUpdates(mode, options) {
      const raw = await revisionRequest(base, "asx_ApplyDataUpdates", {
        Mode: mode,
        ...(options?.retry !== undefined ? { Retry: options.retry } : {}),
        ...(options?.failed ? { FailedItem: options.failed.item, FailedMessage: options.failed.message } : {}),
      });
      return parseDataUpdateStatus(raw);
    },
    async dryRun(table, recordId, triggers) {
      // IncludeOutcomes: the Test run lists each outcome's value; other callers leave it off and get "[]".
      return parseDryRun(await revisionRequest(base, "asx_RunRules", { TableName: table, RecordId: recordId, Triggers: triggers, IncludeOutcomes: true }));
    },
    getClientUrl: () => base,
    async fetchJson(path) {
      const res = await fetch(`${base}/api/data/${API_VERSION}/${path}`, {
        method: "GET",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "OData-MaxVersion": "4.0",
          "OData-Version": "4.0",
          "Content-Type": "application/json; charset=utf-8",
        },
      });
      if (!res.ok) throw new Error(`Metadata fetch failed (${res.status}) for ${path}`);
      return res.json();
    },
    async executeBatch(boundary, body) {
      const res = await fetch(`${base}/api/data/${API_VERSION}/$batch`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": `multipart/mixed; boundary=${boundary}`,
          Accept: "application/json",
          "OData-MaxVersion": "4.0",
          "OData-Version": "4.0",
        },
        body,
      });
      return { httpStatus: res.status, text: await res.text() };
    },
    async validateRule(ruleId) {
      const res = await fetch(`${base}/api/data/${API_VERSION}/asx_ValidateRule`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
          "OData-MaxVersion": "4.0",
          "OData-Version": "4.0",
        },
        body: JSON.stringify({ RuleId: ruleId }),
      });
      if (!res.ok) throw new Error(`asx_ValidateRule failed (${res.status})`);
      const raw = await res.json();
      const isValid: boolean = raw.IsValid ?? false;
      const issuesParsed = raw.Issues ? JSON.parse(raw.Issues) : { isValid, issues: [] };
      const issues: ApiIssue[] = issuesParsed.issues ?? [];
      return { isValid, issues, draftHash: raw.DraftHash };
    },
    // Lifecycle status reasons (docs/Schema.md §2.1): Draft = 1, Published = 753840000.
    publishRule: (ruleId) => patchStatus(base, "publishRule", ruleId, 753840000),
    unpublishRule: (ruleId) => patchStatus(base, "unpublishRule", ruleId, 1),
    readPublishedRule: async (ruleId) => (await revisionRequest(base, "asx_ReadPublishedRule", { RuleId: ruleId })).Definition,
    openRuleDraft: async (ruleId) => (await revisionRequest(base, "asx_OpenRuleDraft", { RuleId: ruleId })).DraftId,
    copyRule: async (ruleId) => (await revisionRequest(base, "asx_CopyRule", { RuleId: ruleId })).NewRuleId,
    deleteRule: async (ruleId) => { await revisionRequest(base, "asx_DeleteRule", { RuleId: ruleId }); },
    restoreRuleDraft: async (ruleId) => { await revisionRequest(base, "asx_RestoreRuleDraft", { RuleId: ruleId }); },
  };
}

async function patchStatus(base: string, op: string, ruleId: string, statuscode: number): Promise<void> {
  const res = await fetch(`${base}/api/data/${API_VERSION}/asx_rules(${ruleId})`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: PATCH_HEADERS,
    body: JSON.stringify({ statuscode }),
  });
  if (!res.ok) { const raw = await res.json().catch(() => null); throw new Error(`${op} PATCH failed (${res.status}): ${raw?.error?.message ?? "Request failed"}`); }
}

async function revisionRequest(base: string, name: string, body: Record<string, string | number | boolean>): Promise<any> {
  const response = await fetch(`${base}/api/data/${API_VERSION}/${name}`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) { const raw = await response.json().catch(() => null); throw new Error(raw?.error?.message ?? `${name} failed (${response.status})`); }
  return response.status === 204 ? {} : response.json();
}
