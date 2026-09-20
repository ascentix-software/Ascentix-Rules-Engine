// Types for devOrg.mjs (see its header for why the implementation is JS). Consumed through the
// facade client/test-dev/devOrg.ts by the vitest + Playwright harness.
import type { EditorApi } from "../src/editor/webapi";

export type OrgIdentity = "user" | "sp" | "authorSp" | "tierc";

export interface OrgCreds {
  clientId: string;
  secret: string;
  tenantId: string;
}

export interface EnvOptions {
  /** Process-env layer (default: process.env). Checked before the .env file. */
  env?: Record<string, string | undefined>;
  /** The dotenv file (default: the repo-root .env); `null` disables the file layer. */
  envFile?: string | null;
}

export interface DevOrgOptions extends EnvOptions {
  /** Target this URL instead of the identity's env key (e.g. the Tier-C runner's --org). */
  url?: string;
  /** Use this bearer token verbatim — no mint, no cache (the existing tokenOverride seam). */
  tokenOverride?: string;
  /** fetch implementation (tests inject a mock). */
  fetch?: typeof fetch;
  /** execFileSync-compatible runner for the az mint (tests inject a stub). */
  exec?: (file: string, args: string[], opts: Record<string, unknown>) => string;
}

export interface OrgResponse {
  status: number;
  ok: boolean;
  text: string;
  json: any;
  headers: Headers;
}

export interface RunRulesOptions {
  recordId?: string;
  recordJson?: string;
  /** OnCreate|OnForm|Manual|OnUpdate|OnDelete or the numeric form; default Manual. */
  triggers?: string;
  includeDiagnostics?: boolean;
}

export interface RunRulesResult {
  isValid: boolean;
  failedRuleCount: number;
  firedActions: any[];
  /** Parsed Diagnostics payload when includeDiagnostics was set (null otherwise). */
  diagnostics: { nodes?: Array<{ table?: string; nodeId?: string; rows: number }> } | null;
}

export interface OrgHandle {
  identity: OrgIdentity;
  url: string;
  /** Bearer token for this identity (process-cached until near expiry). */
  token(): Promise<string>;
  /** Synchronous token — `user` identity only (injected DATAVERSE_TOKEN or the az mint). */
  tokenSync(): string;
  /** One Web API round-trip with the OData headers. Never throws on a non-2xx status. */
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<OrgResponse>;
  /** The editor's own port (EditorApi) over this identity; errors are "<op> <set> failed (<status>): <body>". */
  api: EditorApi;
  updateRecord(entitySet: string, id: string, data: Record<string, unknown>): Promise<void>;
  /** Rules use asx_DeleteRule; other DELETE 404s require a confirming GET 404. */
  deleteRecord(entitySet: string, id: string): Promise<void>;
  runRules(tableName: string, opts?: RunRulesOptions): Promise<RunRulesResult>;
}

export const API_VERSION: string;
export const ENV_FILE: string;

export function readEnvFile(path?: string): Record<string, string>;
export function envOr(env: Record<string, string | undefined>, ...names: string[]): string | undefined;
export function orgUrl(identity?: OrgIdentity, opts?: DevOrgOptions): string;
export function orgCreds(identity: OrgIdentity, opts?: EnvOptions): OrgCreds;
export function resetTokenCache(): void;
export function mintAzToken(resource: string, opts?: { exec?: DevOrgOptions["exec"] }): { token: string; exp: number };
export function mintClientCredentialsToken(
  url: string,
  creds: OrgCreds,
  opts?: { fetch?: typeof fetch; label?: string },
): Promise<{ token: string; exp: number }>;
export function devOrg(identity?: OrgIdentity, opts?: DevOrgOptions): OrgHandle;
