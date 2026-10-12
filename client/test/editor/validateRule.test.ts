import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ApiIssue } from "../../src/editor/webapi";

// ── helpers ──────────────────────────────────────────────────────────────────

const RULE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/** Minimal Xrm stub: only resolveXrm() touches these fields. */
function makeXrm(fetchImpl: typeof fetch): any {
  return {
    WebApi: {
      retrieveRecord: async () => { throw new Error("unused"); },
      retrieveMultipleRecords: async () => { throw new Error("unused"); },
      createRecord: async () => { throw new Error("unused"); },
    },
    Utility: {
      getGlobalContext: () => ({ getClientUrl: () => "https://org.crm.dynamics.com" }),
    },
    _fetchImpl: fetchImpl,
  };
}

/**
 * Build a mock fetch that responds to POST asx_ValidateRule with the given API payload,
 * and to PATCH asx_rules(<id>) with 204 No Content.
 */
function makeFetch(validateResponse: { IsValid: boolean; Issues: string }): typeof fetch {
  return vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("asx_ValidateRule") && opts?.method === "POST") {
      return new Response(JSON.stringify(validateResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("asx_rules(") && opts?.method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${opts?.method ?? "GET"} ${urlStr}`);
  }) as unknown as typeof fetch;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("validateRule — port method", () => {
  let originalWindow: any;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function makePort(fetchMock: typeof fetch) {
    // createWebApiPort() calls resolveXrm() which reads window.Xrm.
    // We stub window + global fetch so the implementation uses our mock.
    const xrm = makeXrm(fetchMock);
    (globalThis as any).window = { Xrm: xrm };
    globalThis.fetch = fetchMock;

    // Dynamic import so the module re-evaluates resolveXrm() after we patch globals.
    const { createWebApiPort } = await import("../../src/editor/webapi");
    return createWebApiPort();
  }

  it("parses IsValid=false and the issues array", async () => {
    const issue: ApiIssue = {
      severity: "Error",
      code: "STRUCT_NO_ACTIONS",
      message: "Rule has no actions defined.",
      target: { kind: "Rule", id: RULE_ID },
    };
    const apiPayload = {
      IsValid: false,
      Issues: JSON.stringify({ isValid: false, issues: [issue] }),
    };
    const fetchMock = makeFetch(apiPayload);
    const port = await makePort(fetchMock);

    const result = await port.validateRule(RULE_ID);

    expect(result.isValid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe("STRUCT_NO_ACTIONS");
    expect(result.issues[0].severity).toBe("Error");
    expect(result.issues[0].target.id).toBe(RULE_ID);
    expect(result.issues[0].target.kind).toBe("Rule");
  });

  it("sends the RuleId in the POST body to asx_ValidateRule", async () => {
    const apiPayload = {
      IsValid: true,
      Issues: JSON.stringify({ isValid: true, issues: [] }),
    };
    const fetchMock = makeFetch(apiPayload);
    const port = await makePort(fetchMock);

    await port.validateRule(RULE_ID);

    const calls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls;
    const [url, opts] = calls[0];
    expect(String(url)).toContain("asx_ValidateRule");
    expect(opts?.method).toBe("POST");
    const body = JSON.parse(opts?.body as string);
    expect(body.RuleId).toBe(RULE_ID);
  });

  it("accepts a valid verdict without requiring a draft hash", async () => {
    const apiPayload = {
      IsValid: true,
      Issues: JSON.stringify({ isValid: true, issues: [] }),
    };
    const fetchMock = makeFetch(apiPayload);
    const port = await makePort(fetchMock);

    const result = await port.validateRule(RULE_ID);

    expect(result.isValid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.draftHash).toBeUndefined();
  });

  it("publishRule PATCHes statuscode=753840000 on asx_rules(<id>)", async () => {
    const apiPayload = { IsValid: true, Issues: JSON.stringify({ isValid: true, issues: [] }) };
    const fetchMock = makeFetch(apiPayload);
    const port = await makePort(fetchMock);

    await port.publishRule(RULE_ID);

    const calls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls;
    const [url, opts] = calls[0];
    expect(String(url)).toContain(`asx_rules(${RULE_ID})`);
    expect(opts?.method).toBe("PATCH");
    const body = JSON.parse(opts?.body as string);
    expect(body.statuscode).toBe(753840000);
  });

  it("unpublishRule PATCHes statuscode=1 (Draft) on asx_rules(<id>)", async () => {
    const apiPayload = { IsValid: true, Issues: JSON.stringify({ isValid: true, issues: [] }) };
    const fetchMock = makeFetch(apiPayload);
    const port = await makePort(fetchMock);

    await port.unpublishRule(RULE_ID);

    const calls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls;
    const [url, opts] = calls[0];
    expect(String(url)).toContain(`asx_rules(${RULE_ID})`);
    expect(opts?.method).toBe("PATCH");
    const body = JSON.parse(opts?.body as string);
    expect(body.statuscode).toBe(1);
  });
});
