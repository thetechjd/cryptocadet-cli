import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpServerClient } from '../src/server/client.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, echoedAuth: (init.headers as Record<string, string>)?.['authorization'] ?? null }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('httpServerClient', () => {
  it('attaches the Authorization header from the auth provider', async () => {
    const calls = stubFetch();
    const client = httpServerClient('https://api.example/', async () => 'ApiKey k-1');
    await client.listProducts();
    expect(calls[0]?.url).toBe('https://api.example/v4/products');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('ApiKey k-1');
  });

  it('throws a clear error on auth-required endpoints when unauthenticated', async () => {
    stubFetch();
    const client = httpServerClient('https://api.example', async () => null);
    await expect(client.listProducts()).rejects.toThrow(/not authenticated/);
    await expect(client.requestQuote({ token: '0x', recipient: '0x', purpose: 'per_call' })).rejects.toThrow(/not authenticated/);
  });

  it('builds REST paths and methods for seller endpoints', async () => {
    const calls = stubFetch();
    const client = httpServerClient('https://api.example', async () => 'Bearer t');
    await client.createProduct({ name: 'API call', token: '0xabc', unitPrice: '1000' });
    await client.cancelSub('sub-9');
    expect(calls[0]).toMatchObject({ url: 'https://api.example/v4/products' });
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[1]?.url).toBe('https://api.example/v4/subscriptions/sub-9/cancel');
  });

  it('builds the private-sharing and origin-secret calls', async () => {
    const calls = stubFetch();
    const client = httpServerClient('https://api.example', async () => 'Bearer t');
    await client.addGrant('p-1', 'client@example.com', 'unlock');
    await client.listGrants('p-1');
    await client.revokeGrant('p-1', 'g-9');
    await client.originSecret();
    await client.rotateOriginSecret();
    expect(calls.map((c) => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'POST https://api.example/v4/products/p-1/grants',
      'GET https://api.example/v4/products/p-1/grants',
      'DELETE https://api.example/v4/products/p-1/grants/g-9',
      'GET https://api.example/v4/accounts/me/origin-secret',
      'POST https://api.example/v4/accounts/me/origin-secret/rotate',
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: 'client@example.com', mode: 'unlock' });
  });
});
