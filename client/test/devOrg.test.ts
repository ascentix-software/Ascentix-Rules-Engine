import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devOrg, orgUrl, orgCreds, readEnvFile, resetTokenCache } from "../test-dev/devOrg";

// DevOrg (client/scripts/devOrg.mjs), hermetic: every network call goes through an injected
// fetch, every az mint through an injected exec, every env through explicit maps/files.

const URL = "https://unit.crm3.dynamics.com";

function envFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "devorg-"));
  const p = join(dir, ".env");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

interface Call { url: string; init: RequestInit & { headers: Record<string, string> } }

// A scripted fetch: each call pops the next response; records what was sent.
function fakeFetch(responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: "{}" };
    return new Response(r.status === 204 ? null : r.body ?? "", { status: r.status, headers: r.headers });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const noEnv = { env: {}, envFile: null as null };
const spEnv = {
  DATAVERSE_URL: URL,
  SERVICE_PRINCIPAL_CLIENT_ID: "sp-id",
  SERVICE_PRINCIPAL_CLIENT_SECRET: "sp-secret",
  SERVICE_PRINCIPAL_TENANT_ID: "sp-tenant",
  AUTHOR_SP_CLIENT_ID: "au-id",
  AUTHOR_SP_CLIENT_SECRET: "au-secret",
  AUTHOR_SP_TENANT_ID: "au-tenant",
  TIERC_URL: "https://tierc.crm.dynamics.com/",
  LOCALIZATION_ENV_URL: "https://loc.crm.dynamics.com",
};

beforeEach(() => resetTokenCache());

describe("env / .env resolution", () => {
  it("reads KEY=value lines, skipping comments", () => {
    const p = envFile(["# comment", "DATAVERSE_URL = https://file.crm.dynamics.com/ ", "X=1"]);
    expect(readEnvFile(p)).toEqual({ DATAVERSE_URL: "https://file.crm.dynamics.com/", X: "1" });
    expect(readEnvFile(join(p, "missing"))).toEqual({});
  });

  it("process env wins over the .env file; an empty process value falls through to the file", () => {
    const p = envFile(["DATAVERSE_URL=https://file.crm.dynamics.com/"]);
    expect(orgUrl("user", { env: {}, envFile: p })).toBe("https://file.crm.dynamics.com");
    expect(orgUrl("user", { env: { DATAVERSE_URL: "" }, envFile: p })).toBe("https://file.crm.dynamics.com");
    expect(orgUrl("user", { env: { DATAVERSE_URL: "https://proc.crm.dynamics.com//" }, envFile: p })).toBe(
      "https://proc.crm.dynamics.com",
    );
  });

  it("names the missing key when nothing resolves", () => {
    expect(() => orgUrl("user", noEnv)).toThrow(/DATAVERSE_URL not set \(checked process.env and \.\.\/\.env\)/);
    expect(() => orgUrl("tierc", noEnv)).toThrow(/TIERC_URL \/ LOCALIZATION_ENV_URL not set/);
    expect(() => orgCreds("authorSp", noEnv)).toThrow(/AUTHOR_SP_CLIENT_ID\/SECRET\/TENANT_ID not set/);
    expect(() => orgCreds("sp", noEnv)).toThrow(/SERVICE_PRINCIPAL_CLIENT_ID\/SECRET\/TENANT_ID not set/);
  });
});

describe("identity -> url / creds", () => {
  const o = { env: spEnv, envFile: null as null };
  it("user / sp / authorSp target DATAVERSE_URL; tierc targets TIERC_URL then LOCALIZATION_ENV_URL", () => {
    expect(orgUrl("user", o)).toBe(URL);
    expect(orgUrl("sp", o)).toBe(URL);
    expect(orgUrl("authorSp", o)).toBe(URL);
    expect(orgUrl("tierc", o)).toBe("https://tierc.crm.dynamics.com");
    expect(orgUrl("tierc", { env: { ...spEnv, TIERC_URL: "" }, envFile: null })).toBe("https://loc.crm.dynamics.com");
    expect(orgUrl("tierc", { ...o, url: "https://override.crm.dynamics.com/" })).toBe("https://override.crm.dynamics.com");
  });

  it("sp and tierc mint with SERVICE_PRINCIPAL_*, authorSp with AUTHOR_SP_*, user has none", () => {
    expect(orgCreds("sp", o)).toEqual({ clientId: "sp-id", secret: "sp-secret", tenantId: "sp-tenant" });
    expect(orgCreds("tierc", o)).toEqual({ clientId: "sp-id", secret: "sp-secret", tenantId: "sp-tenant" });
    expect(orgCreds("authorSp", o)).toEqual({ clientId: "au-id", secret: "au-secret", tenantId: "au-tenant" });
    expect(() => orgCreds("user", o)).toThrow(/no client-credentials/);
    expect(() => devOrg("nope" as any, o)).toThrow(/unknown identity 'nope'/);
  });
});

describe("user tokens", () => {
  it("DATAVERSE_TOKEN injection wins over the az mint", async () => {
    const exec = vi.fn(() => { throw new Error("az must not run"); });
    const { fn, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    const org = devOrg("user", { env: { DATAVERSE_URL: URL, DATAVERSE_TOKEN: " injected " }, envFile: null, exec, fetch: fn });
    expect(org.tokenSync()).toBe("injected");
    expect(await org.token()).toBe("injected");
    await org.request("GET", "WhoAmI");
    expect(calls[0].init.headers.Authorization).toBe("Bearer injected");
    expect(exec).not.toHaveBeenCalled();
  });

  it("az mint: json output, shell on win32, cached per url for the process", () => {
    const exec = vi.fn(() => JSON.stringify({ accessToken: "az-tok", expires_on: Math.floor(Date.now() / 1000) + 3600 }));
    const opts = { env: { DATAVERSE_URL: URL }, envFile: null as null, exec };
    expect(devOrg("user", opts).tokenSync()).toBe("az-tok");
    expect(devOrg("user", opts).tokenSync()).toBe("az-tok"); // a second handle hits the cache
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, execOpts] = (exec.mock.calls as any)[0];
    expect(file).toBe("az");
    expect(args).toEqual(["account", "get-access-token", "--resource", URL, "-o", "json"]);
    expect(execOpts.shell).toBe(process.platform === "win32");
    // Another url is another cache entry.
    expect(devOrg("user", { ...opts, url: "https://other.crm.dynamics.com" }).tokenSync()).toBe("az-tok");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("az mint: an expired cache entry re-mints; a plain (tsv) token is accepted; failure names az login", () => {
    let n = 0;
    const exec = vi.fn(() => JSON.stringify({ accessToken: `tok${++n}`, expires_on: Math.floor(Date.now() / 1000) + 30 }));
    const opts = { env: { DATAVERSE_URL: URL }, envFile: null as null, exec };
    expect(devOrg("user", opts).tokenSync()).toBe("tok1");
    expect(devOrg("user", opts).tokenSync()).toBe("tok2"); // 30s left < the 60s skew => re-mint
    resetTokenCache();
    expect(devOrg("user", { ...opts, exec: () => "plain.jwt.token\n" }).tokenSync()).toBe("plain.jwt.token");
    resetTokenCache();
    expect(() => devOrg("user", { ...opts, exec: () => "" }).tokenSync()).toThrow(/Run 'az login' first/);
  });

  it("tokenOverride is used verbatim", async () => {
    const org = devOrg("user", { env: { DATAVERSE_URL: URL }, envFile: null, tokenOverride: "fixed", exec: () => { throw new Error("no"); } });
    expect(org.tokenSync()).toBe("fixed");
    expect(await org.token()).toBe("fixed");
  });
});

describe("client-credentials tokens", () => {
  it("sp / authorSp post to the tenant's token endpoint with the org's .default scope, cached per identity", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: JSON.stringify({ access_token: "sp-tok", expires_in: 3600 }) },
      { status: 200, body: JSON.stringify({ access_token: "au-tok", expires_in: 3600 }) },
    ]);
    const o = { env: spEnv, envFile: null as null, fetch: fn };
    expect(await devOrg("sp", o).token()).toBe("sp-tok");
    expect(await devOrg("sp", o).token()).toBe("sp-tok");
    expect(await devOrg("authorSp", o).token()).toBe("au-tok");
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe("https://login.microsoftonline.com/sp-tenant/oauth2/v2.0/token");
    expect(String(calls[0].init.body)).toContain(`scope=${encodeURIComponent(`${URL}/.default`)}`);
    expect(String(calls[0].init.body)).toContain("client_id=sp-id");
    expect(calls[1].url).toBe("https://login.microsoftonline.com/au-tenant/oauth2/v2.0/token");
    expect(() => devOrg("sp", o).tokenSync()).toThrow(/mints asynchronously/);
  });

  it("a failed mint names the identity, status and org", async () => {
    const { fn } = fakeFetch([{ status: 401, body: "bad secret" }]);
    await expect(devOrg("authorSp", { env: spEnv, envFile: null, fetch: fn }).token()).rejects.toThrow(
      `authorSp token acquisition failed (401) for ${URL}: bad secret`,
    );
  });
});

describe("web api", () => {
  const base = { env: { DATAVERSE_URL: URL, DATAVERSE_TOKEN: "t" }, envFile: null as null };

  it("request: OData headers, JSON body, absolute pass-through, never throws on non-2xx", async () => {
    const { fn, calls } = fakeFetch([{ status: 403, body: "denied" }, { status: 200, body: '{"value":[]}' }]);
    const org = devOrg("user", { ...base, fetch: fn });
    const r = await org.request("POST", "asx_SyncSteps", { Mode: "RemoveAll" });
    expect(r.status).toBe(403);
    expect(r.ok).toBe(false);
    expect(r.text).toBe("denied");
    expect(r.json).toBeNull();
    expect(calls[0].url).toBe(`${URL}/api/data/v9.2/asx_SyncSteps`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe('{"Mode":"RemoveAll"}');
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer t",
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      "Content-Type": "application/json; charset=utf-8",
    });
    const next = `${URL}/api/data/v9.2/asx_rules?$skiptoken=abc`;
    const r2 = await org.request("GET", next);
    expect(calls[1].url).toBe(next);
    expect(calls[1].init.headers["Content-Type"]).toBeUndefined();
    expect(r2.json).toEqual({ value: [] });
  });

  it("api: createRecord parses OData-EntityId; executeBatch sends the raw multipart body", async () => {
    const { fn, calls } = fakeFetch([
      { status: 204, headers: { "OData-EntityId": `${URL}/api/data/v9.2/sample_orders(11111111-2222-3333-4444-555555555555)` } },
      { status: 200, body: "--b--" },
    ]);
    const org = devOrg("user", { ...base, fetch: fn });
    expect(await org.api.createRecord("sample_orders", { sample_name: "x" })).toBe("11111111-2222-3333-4444-555555555555");
    expect(org.api.getClientUrl()).toBe(URL);
    const b = await org.api.executeBatch("b", "--b\r\n...");
    expect(b).toEqual({ httpStatus: 200, text: "--b--" });
    expect(calls[1].init.body).toBe("--b\r\n...");
    expect(calls[1].init.headers["Content-Type"]).toBe("multipart/mixed; boundary=b");
  });

  it("error shapes: '<op> <set> failed (<status>): <body>' and the body-less variants", async () => {
    const { fn } = fakeFetch([
      { status: 400, body: "This record could not be saved: Too big." },
      { status: 400, body: "blocked" },
      { status: 500, body: "boom" },
      { status: 404 },
      { status: 404, body: "nf" },
      { status: 400, body: "bad filter" },
      { status: 500 },
      { status: 403 },
      { status: 400 },
      { status: 500, body: "engine" },
    ]);
    const org = devOrg("user", { ...base, fetch: fn });
    await expect(org.api.createRecord("sample_orders", {})).rejects.toThrow(
      "createRecord sample_orders failed (400): This record could not be saved: Too big.",
    );
    await expect(org.updateRecord("sample_orders", "id", {})).rejects.toThrow("updateRecord sample_orders failed (400): blocked");
    await expect(org.deleteRecord("sample_orders", "id")).rejects.toThrow("delete sample_orders(id) failed (500): boom");
    await expect(org.deleteRecord("sample_orders", "id")).resolves.toBeUndefined(); // 404 = already gone
    await expect(org.api.retrieveRecord("sample_orders", "id")).rejects.toThrow(/^retrieveRecord sample_orders failed \(404\)$/);
    await expect(org.api.retrieveMultipleRecords("sample_orders", "?$filter=x")).rejects.toThrow(
      "retrieveMultipleRecords sample_orders failed (400): bad filter",
    );
    await expect(org.api.fetchJson("EntityDefinitions")).rejects.toThrow("fetchJson failed (500) for EntityDefinitions");
    await expect(org.api.validateRule("r")).rejects.toThrow(/^asx_ValidateRule failed \(403\)$/);
    await expect(org.api.publishRule("r")).rejects.toThrow(/^publishRule failed \(400\)$/);
    await expect(org.runRules("sample_order")).rejects.toThrow("asx_RunRules failed (500): engine");
  });

  it("runRules: defaults Triggers to Manual, adds IncludeDiagnostics on request, parses Results + Diagnostics", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: JSON.stringify({ IsValid: false, FailedRuleCount: 1, Results: '[{"Message":"Too big."}]' }) },
      { status: 200, body: JSON.stringify({ IsValid: true, Results: "[]", Diagnostics: '{"nodes":[{"table":"sample_order","rows":1}]}' }) },
    ]);
    const org = devOrg("user", { ...base, fetch: fn });
    const v = await org.runRules("sample_order", { recordId: "id" });
    expect(v).toEqual({ isValid: false, failedRuleCount: 1, firedActions: [{ Message: "Too big." }], diagnostics: null });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ TableName: "sample_order", RecordId: "id", Triggers: "Manual" });
    const d = await org.runRules("sample_order", { recordJson: "{}", triggers: "4", includeDiagnostics: true });
    expect(d.diagnostics).toEqual({ nodes: [{ table: "sample_order", rows: 1 }] });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      TableName: "sample_order", RecordJson: "{}", Triggers: "4", IncludeDiagnostics: true,
    });
  });

  it("validateRule parses the Issues payload", async () => {
    const { fn } = fakeFetch([{ status: 200, body: JSON.stringify({ IsValid: false, Issues: '{"issues":[{"code":"X"}]}' }) }]);
    const org = devOrg("user", { ...base, fetch: fn });
    expect(await org.api.validateRule("r")).toEqual({ isValid: false, issues: [{ code: "X" }] });
  });
});
