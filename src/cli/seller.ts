// SELLER / REMOTE command handlers. These are a CLI front-end over the server API; they
// carry NO key risk and hold NO locally authoritative state. Every call writes through to
// (or reads from) the server's postgres via the authenticated client.

import { loadConfig } from '../config/config.js';
import { httpServerClient, type ServerClient } from '../server/client.js';
import { readCredential, storeCredential, clearCredential, authHeader, type CredentialKind } from '../server/auth.js';

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
