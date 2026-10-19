import { describe, expect, it, vi } from 'vitest';
import { getToken, TaskApi, MsalFactory } from '../src/auth';

function task(scheme: string | undefined, params: Record<string, string>, vars: Record<string, string> = {}): TaskApi {
  return {
    getEndpointUrl: () => 'https://org.crm.dynamics.com/',
    getEndpointAuthorizationScheme: () => scheme,
    getEndpointAuthorizationParameter: (_id, key) => (_id === 'SYSTEMVSSCONNECTION' ? 'sys-token' : params[key]),
    getVariable: (n) => vars[n],
    setSecret: vi.fn(),
  };
}

describe('getToken', () => {
  it('uses the client secret for the ServicePrincipal scheme', async () => {
    const acquire = vi.fn().mockResolvedValue('dv-token');
    const factory: MsalFactory = vi.fn(() => ({ acquireToken: acquire }));
    const t = task('ServicePrincipal', { tenantId: 'ten', applicationId: 'app', clientSecret: 'sec' });
    const r = await getToken('conn', { task: t, msalFactory: factory });
    expect(r).toEqual({ url: 'https://org.crm.dynamics.com', token: 'dv-token' });
    expect(factory).toHaveBeenCalledWith({
      clientId: 'app',
      authority: 'https://login.microsoftonline.com/ten',
      clientSecret: 'sec',
    });
    expect(acquire).toHaveBeenCalledWith(['https://org.crm.dynamics.com/.default']);
    expect(t.setSecret).toHaveBeenCalledWith('sec');
  });

  it('posts to the OIDC URI and asserts the id token for WorkloadIdentityFederation', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ oidcToken: 'oidc' }), { status: 200 }));
    const acquire = vi.fn().mockResolvedValue('dv-token');
    const factory: MsalFactory = vi.fn(() => ({ acquireToken: acquire }));
    const t = task(
      'WorkloadIdentityFederation',
      { tenantid: 'ten', serviceprincipalid: 'app' },
      { 'System.OidcRequestUri': 'https://vstoken.dev.azure.com/oidc' },
    );
    const r = await getToken('conn-id', { task: t, fetchImpl: f as unknown as typeof fetch, msalFactory: factory });
    expect(r.token).toBe('dv-token');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://vstoken.dev.azure.com/oidc?api-version=7.1&serviceConnectionId=conn-id');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sys-token');
    expect(factory).toHaveBeenCalledWith({
      clientId: 'app',
      authority: 'https://login.microsoftonline.com/ten',
      clientAssertion: 'oidc',
    });
  });

  it('fails when the OIDC request fails', async () => {
    const f = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    const t = task('WorkloadIdentityFederation', { tenantid: 't', serviceprincipalid: 'a' }, { 'System.OidcRequestUri': 'https://x/oidc' });
    await expect(getToken('c', { task: t, fetchImpl: f as unknown as typeof fetch })).rejects.toThrow('OIDC token request failed (401)');
  });

  it('rejects an unsupported scheme', async () => {
    await expect(getToken('c', { task: task('UsernamePassword', {}) })).rejects.toThrow('Unsupported service connection authentication scheme');
  });

  it('reports a missing parameter', async () => {
    await expect(getToken('c', { task: task('ServicePrincipal', { tenantId: 't' }) })).rejects.toThrow('no clientSecret');
  });
});
