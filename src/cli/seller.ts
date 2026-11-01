// SELLER / REMOTE command handlers. These are a CLI front-end over the server API; they
// carry NO key risk and hold NO locally authoritative state. Every call writes through to
// (or reads from) the server's postgres via the authenticated client.

import { loadConfig } from '../config/config.js';
import { httpServerClient, type ServerClient } from '../server/client.js';
import { readCredential, storeCredential, clearCredential, authHeader, type CredentialKind } from '../server/auth.js';
import { loginWithPassword } from '../server/account-login.js';

/** Build a server client whose auth header comes from the keychain-stored credential. */
export async function makeServerClient(): Promise<ServerClient> {
  const cfg = loadConfig();
  return httpServerClient(cfg.serverBaseUrl, async () => {
    const cred = await readCredential(cfg.serverAuthRef);
    return cred ? authHeader(cred) : null;
  });
}

export async function login(kind: CredentialKind, value: string): Promise<{ ok: true; kind: CredentialKind }> {
  const cfg = loadConfig();
  await storeCredential(cfg.serverAuthRef, { kind, value });
  return { ok: true, kind };
}

export async function logout(): Promise<{ ok: true }> {
  const cfg = loadConfig();
  await clearCredential(cfg.serverAuthRef);
  return { ok: true };
}

/** Sign in with a CryptoCadet web account and store its v4 API key in the keychain. */
export async function loginWithAccount(email: string, password: string): Promise<{ ok: true; kind: 'apikey'; email: string; handle: string | null }> {
  const cfg = loadConfig();
  const apiKey = await loginWithPassword(email, password);
  await storeCredential(cfg.serverAuthRef, { kind: 'apikey', value: apiKey });
  // Confirm the key works against this CLI's server and show who we are.
  const me = await fetch(`${cfg.serverBaseUrl.replace(/\/$/, '')}/v4/accounts/me`, { headers: { authorization: authHeader({ kind: 'apikey', value: apiKey }) } });
  const body = me.ok ? ((await me.json()) as { email?: string | null; handle?: string | null }) : {};
  return { ok: true, kind: 'apikey', email: body.email ?? email.trim().toLowerCase(), handle: body.handle ?? null };
}

/** An item by id or by its gateway slug (/v4/g/<handle>/<slug>). */
export async function resolveItem(client: Pick<ServerClient, 'listProducts'>, ref: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
  const match = (await client.listProducts()).find((p) => p.slug === ref);
  if (!match) throw new Error(`no item with slug "${ref}" (see \`cryptocadet product:list\`)`);
  return match.id;
}
