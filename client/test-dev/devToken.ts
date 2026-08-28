import { devOrg } from "./devOrg";

// Adapter over devOrg("user"): the az-CLI user token for `dataverseUrl` (process-cached until
// near expiry). Requires a local `az login` with access to DEV.
//
// DATAVERSE_TOKEN seam: the maintainer's fresh-org (Tier-C) harness, which is not part of this
// repository, mints an SP client-credentials token per step and injects it here, alongside
// DATAVERSE_URL, so the same live suites run against a fresh org without az. The DEV workflow is
// unchanged: with DATAVERSE_TOKEN unset, the az mint runs as before.
export function getDevToken(dataverseUrl: string): string {
  return devOrg("user", { url: dataverseUrl }).tokenSync();
}
