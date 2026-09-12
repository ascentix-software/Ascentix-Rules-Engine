/** Parsed issue returned by the asx_ValidateRule Custom API. */
export interface ApiIssue {
  severity: string;
  code: string;
  message: string;
  target: { kind: string; id: string; field?: string };
}

// Thin port over the read operations the editor needs. All editor load logic
// depends on this interface, never on Xrm directly, so it is mockable in tests.
export interface WebApiPort {
  retrieveRecord(entity: string, id: string, options?: string): Promise<any>;
  retrieveMultipleRecords(entity: string, options?: string): Promise<{ entities: any[] }>;
  createRecord(entity: string, data: Record<string, any>): Promise<string>;
  /** Call asx_ValidateRule and return the parsed verdict. */
  validateRule(ruleId: string): Promise<{ isValid: boolean; issues: ApiIssue[] }>;
  /** PATCH the rule's statuscode to Published (753840000). */
  publishRule(ruleId: string, etag?: string | null): Promise<void>;
  /** PATCH the rule's statuscode back to Draft (1), the inverse of publishRule. */
  unpublishRule(ruleId: string, etag?: string | null): Promise<void>;
}

// A full-page web resource can reach the Client API on the window or its parent.
function resolveXrm(): any {
  const w = window as any;
  if (w.Xrm && w.Xrm.WebApi) return w.Xrm;
  if (w.parent && w.parent.Xrm && w.parent.Xrm.WebApi) return w.parent.Xrm;
  throw new Error("Xrm.WebApi is not available in this context.");
}

const API_VERSION = "v9.2";

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
      return { isValid, issues };
    },
    // Lifecycle status reasons (docs/Schema.md §2.1): Draft = 1, Published = 753840000.
    publishRule: (ruleId, etag) => patchStatus(base, "publishRule", ruleId, 753840000, etag),
    unpublishRule: (ruleId, etag) => patchStatus(base, "unpublishRule", ruleId, 1, etag),
  };
}

async function patchStatus(base: string, op: string, ruleId: string, statuscode: number, etag?: string | null): Promise<void> {
  const res = await fetch(`${base}/api/data/${API_VERSION}/asx_rules(${ruleId})`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      ...(etag ? { "If-Match": etag } : {}),
    },
    body: JSON.stringify({ statuscode }),
  });
  if (!res.ok) throw new Error(`${op} PATCH failed (${res.status})`);
}
