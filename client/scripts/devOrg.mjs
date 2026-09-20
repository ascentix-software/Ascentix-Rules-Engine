// DevOrg — identity in, org handle out. The ONE implementation of the live harness's
// URL / token / Web API plumbing (env + .env resolution, DATAVERSE_TOKEN injection, the az
// mint, SP client-credentials mints, OData headers, error shaping, token caching, asx_RunRules).
//
// Why plain ESM JavaScript with a sibling `devOrg.d.mts` (rather than TypeScript): the consumers
// are BOTH the vitest/Playwright TypeScript harness (client/test-dev, client/e2e — through the
// thin facade client/test-dev/devOrg.ts) AND the build-step-free node scripts
// (scripts/seed-*.mjs, scripts/tier-c/lib.mjs, scripts/record-live-run.mjs) that run with bare
// `node`. A .mjs is loadable by all three runtimes without a compile step, and the .d.mts gives
// the TypeScript side full types — the same arrangement as scripts/build-docs-lib.mjs + .d.mts.
//
// Identities (CONTEXT.md "DevOrg"):
//   user      the az-CLI signed-in user against DATAVERSE_URL (a DATAVERSE_TOKEN env value, the
//             Tier-C runner's injection seam, wins over the az mint);
//   sp        the full-privilege application user (SERVICE_PRINCIPAL_*) against DATAVERSE_URL;
//   authorSp  the Author-only application user (AUTHOR_SP_*) against DATAVERSE_URL;
//   tierc     the SERVICE_PRINCIPAL_* app user against TIERC_URL ?? LOCALIZATION_ENV_URL.
// Env resolution for every key: process.env first, then the repo-root .env (gitignored).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const API_VERSION = "v9.2";

// The repo-root .env (client/scripts/devOrg.mjs -> client -> repo root). Module-relative, so
// the scripts and suites resolve the same file regardless of cwd.
export const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");

const IDENTITIES = {
  user: { urlKeys: ["DATAVERSE_URL"], creds: null },
  sp: { urlKeys: ["DATAVERSE_URL"], creds: "SERVICE_PRINCIPAL" },
  authorSp: { urlKeys: ["DATAVERSE_URL"], creds: "AUTHOR_SP" },
  tierc: { urlKeys: ["TIERC_URL", "LOCALIZATION_ENV_URL"], creds: "SERVICE_PRINCIPAL" },
};

// ---------------------------------------------------------------- env + .env

// KEY=value lines of a dotenv-style file; '#' comment lines skipped; missing file => {}.
export function readEnvFile(path = ENV_FILE) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// First non-empty value among `names`: process.env (or the given env map) first, then the file.
export function envOr(env, ...names) {
  for (const n of names) {
    const v = process.env[n] ?? env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return undefined;
}

function lookup(opts) {
  const penv = opts.env ?? process.env;
  const file = opts.envFile === null ? {} : readEnvFile(opts.envFile ?? ENV_FILE);
  return (...names) => {
    for (const n of names) {
      const v = penv[n];
      if (v && String(v).trim()) return String(v).trim();
    }
    for (const n of names) {
      const v = file[n];
      if (v && String(v).trim()) return String(v).trim();
    }
    return undefined;
  };
}

function identityOf(identity) {
  const def = IDENTITIES[identity];
  if (!def) throw new Error(`devOrg: unknown identity '${identity}' (expected user | sp | authorSp | tierc)`);
  return def;
}

// The org URL an identity targets (trailing slashes stripped). Throws with the key names when unset.
export function orgUrl(identity = "user", opts = {}) {
  const def = identityOf(identity);
  const url = opts.url ?? lookup(opts)(...def.urlKeys);
  if (!url) {
    throw new Error(
      `${def.urlKeys.join(" / ")} not set (checked process.env and ../.env). Run from client/ with a repo-root .env.`,
    );
  }
  return url.replace(/\/+$/, "");
}

// The client-credentials creds an identity mints with. Never logged. Throws for `user`.
export function orgCreds(identity, opts = {}) {
  const def = identityOf(identity);
  if (!def.creds) throw new Error(`devOrg: identity '${identity}' has no client-credentials (it uses the az user token)`);
  const get = lookup(opts);
  const clientId = get(`${def.creds}_CLIENT_ID`);
  const secret = get(`${def.creds}_CLIENT_SECRET`);
  const tenantId = get(`${def.creds}_TENANT_ID`);
  if (!clientId || !secret || !tenantId) {
    throw new Error(`${def.creds}_CLIENT_ID/SECRET/TENANT_ID not set (checked process.env and ../.env).`);
  }
  return { clientId, secret, tenantId };
}

// ---------------------------------------------------------------- tokens

const tokenCache = new Map(); // `${identity}|${url}` -> { token, exp }
const SKEW_MS = 60 * 1000;

export function resetTokenCache() {
  tokenCache.clear();
}

function cached(key) {
  const hit = tokenCache.get(key);
  return hit && Date.now() < hit.exp - SKEW_MS ? hit.token : undefined;
}

// Mirrors pipelines/client-ci.yml's Deploy stage: a short-lived Dataverse token for the
// signed-in az user. Requires a local `az login` with access to the org. Synchronous.
export function mintAzToken(resource, { exec = execFileSync } = {}) {
  try {
    const out = exec(
      "az",
      ["account", "get-access-token", "--resource", resource.replace(/\/+$/, ""), "-o", "json"],
      // On Windows, `az` resolves to `az.cmd`; spawnSync cannot exec a .cmd directly without a
      // shell (ENOENT / EINVAL under the CVE-2024-27980 mitigation), so opt into the shell there.
      // Args are fixed flags plus our own trusted .env value, not user input.
      { encoding: "utf8", shell: process.platform === "win32" },
    );
    const text = String(out).trim();
    if (!text) throw new Error("empty token");
    let token = text;
    let exp = Date.now() + 50 * 60 * 1000;
    try {
      const j = JSON.parse(text);
      token = j.accessToken;
      if (typeof j.expires_on === "number") exp = j.expires_on * 1000;
      else if (j.expiresOn && !Number.isNaN(Date.parse(j.expiresOn))) exp = Date.parse(j.expiresOn);
    } catch {
      /* tsv-style plain token (older az) — keep the default expiry */
    }
    if (!token) throw new Error("empty token");
    return { token, exp };
  } catch (e) {
    throw new Error(
      `Failed to acquire a Dataverse token via 'az account get-access-token'. Run 'az login' first. Cause: ${String(e)}`,
    );
  }
}

// OAuth2 client-credentials flow for an application user (a Standard-channel caller).
export async function mintClientCredentialsToken(url, creds, { fetch: fetchImpl = globalThis.fetch, label = "SP" } = {}) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.secret,
    scope: `${url.replace(/\/+$/, "")}/.default`,
  });
  const res = await fetchImpl(`https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`${label} token acquisition failed (${res.status}) for ${url}: ${await res.text()}`);
  const j = await res.json();
  return { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
}

// ---------------------------------------------------------------- web api

function shapeError(op, status, body) {
  const err = new Error(`${op} failed (${status})${body === undefined ? "" : `: ${body}`}`);
  err.status = status;
  err.body = body;
  return err;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The org handle. Constructed synchronously; tokens are resolved lazily (and cached per
// identity+url for the process) on the first call that needs one.
export function devOrg(identity = "user", opts = {}) {
  const def = identityOf(identity);
  const url = orgUrl(identity, opts);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const penv = opts.env ?? process.env;
  const key = `${identity}|${url}`;

  function tokenSync() {
    if (opts.tokenOverride) return opts.tokenOverride;
    if (def.creds) throw new Error(`devOrg: identity '${identity}' mints asynchronously, so use token()`);
    // DATAVERSE_TOKEN seam: the Tier-C runner mints an SP token per step for the trial org and
    // injects it (alongside DATAVERSE_URL) so the same suites run against a fresh org without az.
    const injected = penv.DATAVERSE_TOKEN;
    if (typeof injected === "string" && injected.trim()) return injected.trim();
    const hit = cached(key);
    if (hit) return hit;
    const minted = mintAzToken(url, { exec: opts.exec });
    tokenCache.set(key, minted);
    return minted.token;
  }

  async function token() {
    if (!def.creds) return tokenSync();
    if (opts.tokenOverride) return opts.tokenOverride;
    const hit = cached(key);
    if (hit) return hit;
    const minted = await mintClientCredentialsToken(url, orgCreds(identity, opts), { fetch: fetchImpl, label: identity });
    tokenCache.set(key, minted);
    return minted.token;
  }

  async function headers(write, extra) {
    return {
      Authorization: `Bearer ${await token()}`,
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      ...(write ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(extra ?? {}),
    };
  }

  const apiUrl = (path) => (/^https?:\/\//.test(path) ? path : `${url}/api/data/${API_VERSION}/${path}`);

  // One Web API round-trip. Never throws on a non-2xx status — callers shape their own error
  // (or assert on the status, e.g. the privilege-gate 403). A string body is sent verbatim
  // (with `headers` supplying its Content-Type); an object body is JSON.
  async function request(method, path, body, extraHeaders) {
    const raw = typeof body === "string";
    const res = await fetchImpl(apiUrl(path), {
      method,
      headers: await headers(body !== undefined && !raw, extraHeaders),
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, json: parseJson(text), headers: res.headers };
  }

  // EditorApi-compatible client (the editor's own port, client/src/editor/webapi.ts) with a
  // Bearer header instead of credentials:"same-origin". Error messages keep the
  // "<op> <set> failed (<status>): <body>" shape the suites assert on.
  const api = {
    getClientUrl: () => url,
    async createRecord(entity, data) {
      const r = await request("POST", entity, data);
      if (!r.ok) throw shapeError(`createRecord ${entity}`, r.status, r.text);
      const loc = r.headers.get("OData-EntityId") ?? "";
      const m = /\(([^)]+)\)/.exec(loc);
      return m ? m[1] : "";
    },
    async retrieveRecord(entity, id, options) {
      const r = await request("GET", `${entity}(${id})${options ?? ""}`);
      if (!r.ok) throw shapeError(`retrieveRecord ${entity}`, r.status);
      return r.json;
    },
    async retrieveMultipleRecords(entity, options) {
      const r = await request("GET", `${entity}${options ?? ""}`);
      if (!r.ok) throw shapeError(`retrieveMultipleRecords ${entity}`, r.status, r.text);
      return { entities: r.json?.value ?? [] };
    },
    async fetchJson(path) {
      const r = await request("GET", path);
      if (!r.ok) throw new Error(`fetchJson failed (${r.status}) for ${path}`);
      return r.json;
    },
    async executeBatch(boundary, body) {
      const r = await request("POST", "$batch", body, { "Content-Type": `multipart/mixed; boundary=${boundary}` });
      return { httpStatus: r.status, text: r.text };
    },
    async validateRule(ruleId) {
      const r = await request("POST", "asx_ValidateRule", { RuleId: ruleId });
      if (!r.ok) throw shapeError("asx_ValidateRule", r.status);
      const raw = r.json ?? {};
      const parsed = raw.Issues ? JSON.parse(raw.Issues) : { issues: [] };
      return { isValid: raw.IsValid ?? false, issues: parsed.issues ?? [], ...(raw.DraftHash ? { draftHash: raw.DraftHash } : {}) };
    },
    async publishRule(ruleId) {
      const r = await request("PATCH", `asx_rules(${ruleId})`, { statuscode: 753840000 }, { "If-Match": "*" });
      if (!r.ok) throw shapeError("publishRule", r.status, r.text || undefined);
    },
    // Inverse of publishRule: back to Draft (1). See docs/Schema.md §2.1 Lifecycle.
    async unpublishRule(ruleId) {
      const r = await request("PATCH", `asx_rules(${ruleId})`, { statuscode: 1 }, { "If-Match": "*" });
      if (!r.ok) throw shapeError("unpublishRule", r.status);
    },
    async readPublishedRule(ruleId) {
      const r = await request("POST", "asx_ReadPublishedRule", { RuleId: ruleId });
      if (!r.ok) throw shapeError("readPublishedRule", r.status, r.text);
      return r.json.Definition;
    },
    async openRuleDraft(ruleId) {
      const r = await request("POST", "asx_OpenRuleDraft", { RuleId: ruleId });
      if (!r.ok) throw shapeError("openRuleDraft", r.status, r.text);
      return r.json.DraftId;
    },
    async copyRule(ruleId) {
      const r = await request("POST", "asx_CopyRule", { RuleId: ruleId });
      if (!r.ok) throw shapeError("copyRule", r.status, r.text);
      return r.json.NewRuleId;
    },
    async deleteRule(ruleId) {
      const r = await request("POST", "asx_DeleteRule", { RuleId: ruleId });
      if (!r.ok) throw shapeError("asx_DeleteRule", r.status, r.text);
    },
    async restoreRuleDraft(ruleId) {
      const r = await request("POST", "asx_RestoreRuleDraft", { RuleId: ruleId });
      if (!r.ok) throw shapeError("restoreRuleDraft", r.status, r.text);
    },
  };

  // PATCH, throwing "<op> <set> failed (<status>): <body>" — a violating PATCH must surface the
  // Block's 400 body.
  async function updateRecord(entitySet, id, data) {
    const r = await request("PATCH", `${entitySet}(${id})`, data);
    if (!r.ok) throw shapeError(`updateRecord ${entitySet}`, r.status, r.text);
  }

  // Dataverse can return 404 for a failed nested/platform operation even while
  // the requested row survives. Only accept it after confirming that row is gone.
  async function deleteRecord(entitySet, id) {
    if (entitySet === "asx_rules") return api.deleteRule(id);
    const r = await request("DELETE", `${entitySet}(${id})`);
    if (r.ok) return;
    if (r.status === 404) {
      const check = await request("GET", `${entitySet}(${id})`);
      if (check.status === 404) return;
    }
    throw shapeError(`delete ${entitySet}(${id})`, r.status, r.text);
  }

  // Report-only verdict probe. asx_RunRules never throws on a rule outcome and never writes — it
  // returns which actions fired. Triggers ∈ OnCreate|OnForm|Manual|OnUpdate|OnDelete (default
  // Manual). includeDiagnostics adds the per-node traversal rows (`diagnostics.nodes`).
  async function runRules(tableName, o = {}) {
    const body = { TableName: tableName };
    if (o.recordId) body.RecordId = o.recordId;
    if (o.recordJson) body.RecordJson = o.recordJson;
    body.Triggers = o.triggers ?? "Manual";
    if (o.includeDiagnostics) body.IncludeDiagnostics = true;
    const r = await request("POST", "asx_RunRules", body);
    if (!r.ok) throw shapeError("asx_RunRules", r.status, r.text);
    const raw = r.json ?? {};
    return {
      isValid: raw.IsValid ?? true,
      failedRuleCount: raw.FailedRuleCount ?? 0,
      firedActions: raw.Results ? JSON.parse(raw.Results) : [],
      diagnostics: raw.Diagnostics ? parseJson(raw.Diagnostics) : null,
    };
  }

  return { identity, url, token, tokenSync, request, api, updateRecord, deleteRecord, runRules };
}
