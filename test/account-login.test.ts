import { describe, it, expect, vi } from 'vitest';
import { loginWithPassword, AccountLoginError } from '../src/server/account-login.js';

const BASE = 'https://identity.example/api';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function identity(opts: { login: [number, unknown]; session?: [number, unknown] }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/user/login')) return json(...opts.login);
    if (url.endsWith('/user/v4-session')) return json(...(opts.session ?? [200, { apiKey: 'ccx_key' }]));
    return json(404, {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('cryptocadet login (web account)', () => {
  it('exchanges email+password for the account’s v4 API key (same key the web dashboard uses)', async () => {
    const id = identity({ login: [200, { sessionToken: 'jwt-1', isLogged: true }] });
    const key = await loginWithPassword('  You@Example.com ', 'pw', { baseUrl: BASE, fetchImpl: id.fetchImpl });
    expect(key).toBe('ccx_key');
    expect(JSON.parse(String(id.calls[0]!.init!.body))).toEqual({ email: 'you@example.com', password: 'pw' });
    expect((id.calls[1]!.init!.headers as Record<string, string>).authorization).toBe('Bearer jwt-1');
  });

  it('explains an unverified email', async () => {
    const id = identity({ login: [404, { message: 'Email not verified. A new verification email has been sent.', isLogged: false }] });
    await expect(loginWithPassword('a@b.co', 'pw', { baseUrl: BASE, fetchImpl: id.fetchImpl })).rejects.toMatchObject({ code: 'UNVERIFIED' });
  });

  it('reports wrong credentials without echoing the server message', async () => {
    const id = identity({ login: [404, { message: 'Invalid email or password.', isLogged: false }] });
    const err = await loginWithPassword('a@b.co', 'bad', { baseUrl: BASE, fetchImpl: id.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountLoginError);
    expect(err).toMatchObject({ code: 'BAD_CREDENTIALS', message: 'wrong email or password' });
  });

  it('fails clearly when no v4 key comes back', async () => {
    const id = identity({ login: [200, { sessionToken: 'jwt' }], session: [502, {}] });
    await expect(loginWithPassword('a@b.co', 'pw', { baseUrl: BASE, fetchImpl: id.fetchImpl })).rejects.toMatchObject({ code: 'NO_KEY' });
  });

  it('reports an unreachable identity service', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(loginWithPassword('a@b.co', 'pw', { baseUrl: BASE, fetchImpl })).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });
});
