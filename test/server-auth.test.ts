import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { storeCredential, readCredential, clearCredential, authHeader } from '../src/server/auth.js';
import { getKeychain, KEYCHAIN_ACCOUNT } from '../src/custody/keychain.js';

beforeEach(() => {
  process.env.CRYPTOCADET_INSECURE_KEYCHAIN = '1';
});
afterEach(() => {
  delete process.env.CRYPTOCADET_INSECURE_KEYCHAIN;
});

const WALLET_REF = 'cryptocadet-agent-xyz';
const SERVER_REF = 'cryptocadet-server-xyz';

describe('server credential store', () => {
  it('round-trips an API key and builds the right header', async () => {
    await storeCredential(SERVER_REF, { kind: 'apikey', value: 'secret-123' });
    const cred = await readCredential(SERVER_REF);
    expect(cred).toEqual({ kind: 'apikey', value: 'secret-123' });
    expect(authHeader(cred!)).toBe('ApiKey secret-123');
  });

  it('round-trips a JWT and builds a Bearer header', async () => {
    await storeCredential(SERVER_REF, { kind: 'jwt', value: 'jjj.www.ttt' });
    expect(authHeader((await readCredential(SERVER_REF))!)).toBe('Bearer jjj.www.ttt');
  });

  it('clear removes the credential', async () => {
    await storeCredential(SERVER_REF, { kind: 'apikey', value: 'x' });
    await clearCredential(SERVER_REF);
    expect(await readCredential(SERVER_REF)).toBeNull();
  });

  it('the wallet key and the server credential live in SEPARATE keychain entries', async () => {
    // Different service ids => different blast radii. Reading one must not yield the other.
    const kc = await getKeychain();
    await kc.set(WALLET_REF, KEYCHAIN_ACCOUNT, 'WALLET-DATA-KEY'); // wallet entry
    await storeCredential(SERVER_REF, { kind: 'apikey', value: 'SERVER-CRED' }); // server entry

    expect(await kc.get(WALLET_REF, KEYCHAIN_ACCOUNT)).toBe('WALLET-DATA-KEY');
    expect(await readCredential(SERVER_REF)).toEqual({ kind: 'apikey', value: 'SERVER-CRED' });
    // The server ref holds no wallet key; the wallet ref holds no server credential.
    expect(await kc.get(SERVER_REF, KEYCHAIN_ACCOUNT)).toBeNull();
    expect(await readCredential(WALLET_REF)).toBeNull();
  });
});
