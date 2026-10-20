import { describe, expect, it, vi } from 'vitest';
import { Dataverse, DataverseError } from '../src/dataverse';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('Dataverse client', () => {
  it('sends the Web API headers against the v9.2 base', async () => {
    const f = vi.fn().mockResolvedValue(json(200, { ok: 1 }));
    const dv = new Dataverse('https://org.crm.dynamics.com/', 'tok', f as unknown as typeof fetch);
    await dv.get('asx_rules?$top=1');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://org.crm.dynamics.com/api/data/v9.2/asx_rules?$top=1');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: 'odata.include-annotations="*"',
    });
  });

  it('follows @odata.nextLink in getAll', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(200, { value: [1, 2], '@odata.nextLink': 'https://org/api/data/v9.2/x?page=2' }))
      .mockResolvedValueOnce(json(200, { value: [3] }));
    const dv = new Dataverse('https://org', 't', f as unknown as typeof fetch);
    expect(await dv.getAll<number>('x')).toEqual([1, 2, 3]);
    expect(f.mock.calls[1][0]).toBe('https://org/api/data/v9.2/x?page=2');
  });

  it('posts a JSON body', async () => {
    const f = vi.fn().mockResolvedValue(json(200, { r: 1 }));
    const dv = new Dataverse('https://org', 't', f as unknown as typeof fetch);
    expect(await dv.post('asx_ExportRule', { a: 1 })).toEqual({ r: 1 });
    expect(f.mock.calls[0][1].method).toBe('POST');
    expect(f.mock.calls[0][1].body).toBe('{"a":1}');
  });

  it('retries 429 honouring Retry-After', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}, { 'Retry-After': '7' }))
      .mockResolvedValueOnce(json(200, { v: 1 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const dv = new Dataverse('https://org', 't', f as unknown as typeof fetch, sleep);
    expect(await dv.get('x')).toEqual({ v: 1 });
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('caps Retry-After at 120 seconds', async () => {
    const f = vi.fn().mockResolvedValueOnce(json(429, {}, { 'Retry-After': '9999' })).mockResolvedValueOnce(json(200, {}));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await new Dataverse('https://org', 't', f as unknown as typeof fetch, sleep).get('x');
    expect(sleep).toHaveBeenCalledWith(120000);
  });

  it('parses an HTTP-date Retry-After and falls back to backoff on garbage', async () => {
    const date = new Date(Date.now() + 30000).toUTCString();
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}, { 'Retry-After': date }))
      .mockResolvedValueOnce(json(429, {}, { 'Retry-After': 'soon' }))
      .mockResolvedValueOnce(json(200, {}));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await new Dataverse('https://org', 't', f as unknown as typeof fetch, sleep).get('x');
    const first = sleep.mock.calls[0][0] as number;
    expect(first).toBeGreaterThan(25000);
    expect(first).toBeLessThanOrEqual(30000);
    expect(sleep.mock.calls[1][0]).toBe(2000);
  });

  it('cancels the body of a retried response', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const retried = { ok: false, status: 429, headers: new Headers(), body: { cancel } };
    const f = vi.fn().mockResolvedValueOnce(retried).mockResolvedValueOnce(json(200, {}));
    await new Dataverse('https://org', 't', f as unknown as typeof fetch, vi.fn().mockResolvedValue(undefined)).get('x');
    expect(cancel).toHaveBeenCalled();
  });

  it('gives up after 5 retries', async () => {
    const f = vi.fn().mockImplementation(async () => json(503, { error: { code: '0x1', message: 'busy' } }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const dv = new Dataverse('https://org', 't', f as unknown as typeof fetch, sleep);
    await expect(dv.get('x')).rejects.toMatchObject({ status: 503, code: '0x1', message: 'busy' });
    expect(f).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it('maps an OData error body to DataverseError', async () => {
    const f = vi.fn().mockResolvedValue(json(400, { error: { code: '0x80040265', message: 'Bad thing' } }));
    const dv = new Dataverse('https://org', 't', f as unknown as typeof fetch);
    const err = await dv.get('x').catch((e) => e);
    expect(err).toBeInstanceOf(DataverseError);
    expect(err).toMatchObject({ status: 400, code: '0x80040265', message: 'Bad thing' });
  });

  it('does not retry other errors', async () => {
    const f = vi.fn().mockResolvedValue(new Response('boom', { status: 500, statusText: 'Server Error' }));
    const dv = new Dataverse('https://org', 't', f as unknown as typeof fetch);
    await expect(dv.get('x')).rejects.toMatchObject({ status: 500, code: '', message: '500 Server Error' });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
