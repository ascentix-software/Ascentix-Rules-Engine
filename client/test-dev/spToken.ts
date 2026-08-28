import { devOrg } from "./devOrg";

// Adapter over devOrg("sp"): a Dataverse token for the service-principal app-user (the Standard
// channel, like every non-portal caller) via the client-credentials flow, so its Dataverse writes
// resolve to RuleChannel.Standard. Process-cached by the DevOrg module.
export async function getSpToken(): Promise<string> {
  return devOrg("sp").token();
}
