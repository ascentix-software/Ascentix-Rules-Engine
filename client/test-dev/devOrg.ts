// DevOrg facade for the TypeScript harness (vitest L2 suites, Tier-C suites, Playwright e2e).
// The implementation is client/scripts/devOrg.mjs (one JS module shared with the bare-node
// scripts; its header explains the choice); the types are its sibling devOrg.d.mts.
//
//   const org = devOrg("user");            // az user (or the injected DATAVERSE_TOKEN)
//   const org = devOrg("authorSp");        // Author-only application user
//   await org.api.createRecord(...)        // EditorApi-compatible
//   await org.request("POST", "asx_SyncSteps", { Mode: "Sync" })   // raw, never throws
//   await org.runRules("sample_order", { recordId, includeDiagnostics: true })
//
// devApi.ts / devEnv.ts / devToken.ts / spToken.ts remain as thin adapters over this module so
// the existing suites keep their call sites.
export {
  devOrg,
  orgUrl,
  orgCreds,
  readEnvFile,
  envOr,
  resetTokenCache,
  mintAzToken,
  mintClientCredentialsToken,
  API_VERSION,
  ENV_FILE,
} from "../scripts/devOrg.mjs";
export type {
  OrgIdentity,
  OrgHandle,
  OrgResponse,
  OrgCreds,
  DevOrgOptions,
  EnvOptions,
  RunRulesOptions,
  RunRulesResult,
} from "../scripts/devOrg.mjs";
