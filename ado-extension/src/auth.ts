// Loaded lazily: the task library logs to stdout when imported.
import { ConfidentialClientApplication } from '@azure/msal-node';

/**
 * Mirrors the Power Platform Build Tools "powerplatform-spn" handling
 * (microsoft/powerplatform-build-tools, src/params/auth/getCredentials.ts): WorkloadIdentityFederation is the
 * only explicit scheme (parameters tenantid, serviceprincipalid, all lower case). Every other scheme takes the
 * client secret path (parameters tenantId, applicationId, clientSecret) and fails only when those are missing.
 */
export const WIF_SCHEME = 'WorkloadIdentityFederation';

export interface TaskApi {
  getEndpointUrl(id: string, optional: boolean): string | undefined;
  getEndpointAuthorizationScheme(id: string, optional: boolean): string | undefined;
  getEndpointAuthorizationParameter(id: string, key: string, optional: boolean): string | undefined;
  getVariable(name: string): string | undefined;
  setSecret(value: string): void;
}

export interface MsalClientConfig {
  clientId: string;
  authority: string;
  clientSecret?: string;
  clientAssertion?: string;
}

export interface MsalClient {
  acquireToken(scopes: string[]): Promise<string>;
}

export type MsalFactory = (config: MsalClientConfig) => MsalClient;

export interface AuthDeps {
  task?: TaskApi;
  fetchImpl?: typeof fetch;
  msalFactory?: MsalFactory;
}

const defaultMsalFactory: MsalFactory = (config) => {
  const app = new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: config.authority,
      ...(config.clientSecret ? { clientSecret: config.clientSecret } : { clientAssertion: config.clientAssertion }),
    },
  });
  return {
    async acquireToken(scopes) {
      const result = await app.acquireTokenByClientCredential({ scopes });
      if (!result?.accessToken) throw new Error('The token request returned no access token.');
      return result.accessToken;
    },
  };
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`The service connection has no ${name}.`);
  return value;
}

async function requestOidcToken(task: TaskApi, fetchImpl: typeof fetch, connectionId: string): Promise<string> {
  const requestUri = required(
    task.getVariable('System.OidcRequestUri') ?? process.env.SYSTEM_OIDCREQUESTURI,
    'OIDC request URI',
  );
  const accessToken = required(
    task.getEndpointAuthorizationParameter('SYSTEMVSSCONNECTION', 'ACCESSTOKEN', false),
    'System.AccessToken',
  );
  task.setSecret(accessToken);
  const url = `${requestUri}?api-version=7.1&serviceConnectionId=${encodeURIComponent(connectionId)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`The OIDC token request failed (${res.status}).`);
  const body = (await res.json()) as { oidcToken?: string };
  const token = required(body.oidcToken, 'OIDC token in the response');
  task.setSecret(token);
  return token;
}

/** Signs in with the Power Platform service connection; returns the environment URL and a Dataverse access token. */
export async function getToken(connectionId: string, deps: AuthDeps = {}): Promise<{ url: string; token: string }> {
  const task: TaskApi = deps.task ?? (require('azure-pipelines-task-lib/task') as TaskApi);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const msalFactory = deps.msalFactory ?? defaultMsalFactory;

  const url = required(task.getEndpointUrl(connectionId, false), 'environment URL').replace(/\/+$/, '');
  const scheme = task.getEndpointAuthorizationScheme(connectionId, false);
  const param = (key: string) => required(task.getEndpointAuthorizationParameter(connectionId, key, false), key);

  let config: MsalClientConfig;
  if (scheme === WIF_SCHEME) {
    const tenant = param('tenantid');
    config = {
      clientId: param('serviceprincipalid'),
      authority: `https://login.microsoftonline.com/${tenant}`,
      clientAssertion: await requestOidcToken(task, fetchImpl, connectionId),
    };
  } else {
    const secret = task.getEndpointAuthorizationParameter(connectionId, 'clientSecret', false);
    if (!secret) {
      throw new Error('The service connection has no client secret; use a client secret or workload identity federation connection.');
    }
    task.setSecret(secret);
    config = {
      clientId: param('applicationId'),
      authority: `https://login.microsoftonline.com/${param('tenantId')}`,
      clientSecret: secret,
    };
  }

  const token = await msalFactory(config).acquireToken([`${url}/.default`]);
  task.setSecret(token);
  return { url, token };
}
