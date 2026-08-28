import { orgUrl, orgCreds, envOr, readEnvFile } from "./devOrg";

// Adapters over devOrg.ts (the DevOrg module owns env/.env resolution). Kept so the existing
// suites' call sites compile unchanged; new code should call devOrg(identity) directly.

// The single source of the DEV url is the repo-root .env (see .env.example); process.env wins.
export function readDevEnv(): { dataverseUrl: string; seedPrefix: string; runPrefix: string } {
  return {
    dataverseUrl: orgUrl("user"),
    seedPrefix: "ZZ_P2SEED_",
    runPrefix: "ZZ_P2RUN_",
  };
}

// Any other environment-specific value the live harness needs, resolved exactly the way DevOrg
// resolves DATAVERSE_URL: process.env first, then the repo-root .env. Never defaulted: an
// org-specific id guessed wrong points a live suite at the wrong record, so an unset key is a
// loud failure naming the key and what it is. Every key is documented in .env.example.
export function requireDevEnv(name: string, what: string): string {
  const v = envOr(readEnvFile(), name);
  if (!v) {
    throw new Error(`${name} not set (checked process.env and the repo-root .env). ${what} See .env.example.`);
  }
  return v;
}

// SP client-credentials creds (SERVICE_PRINCIPAL_*). Used to drive a second (service-principal) Standard-channel caller.
// Never logged.
export function readSpCreds(): { clientId: string; secret: string; tenantId: string } {
  return orgCreds("sp");
}

// Author-only SP creds (AUTHOR_SP_*): an application user holding ONLY the Rules Engine Author
// role, deliberately zero privileges on the escalation-target business tables; that asymmetry
// is the escalationGuard fixture. Provision it as an application user in the target org, assign
// it the solution-shipped "Rules Engine Author" role, and grant it nothing else.
export function readAuthorSpCreds(): { clientId: string; secret: string; tenantId: string } {
  return orgCreds("authorSp");
}
