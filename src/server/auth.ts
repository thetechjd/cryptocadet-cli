// Server credential store. The CLI authenticates to cryptocadet-server for all REMOTE
// commands and for quote_payment. The credential (API key or JWT) is stored in the OS
// keychain, NEVER in a plaintext dotfile, and under a DIFFERENT keychain service id than
// the agent wallet key — they are different secrets with different blast radii.

import { getKeychain } from '../custody/keychain.js';

const CRED_ACCOUNT = 'server-credential';

export type CredentialKind = 'apikey' | 'jwt';

export interface StoredCredential {
  kind: CredentialKind;
  value: string;
}

export async function storeCredential(serverAuthRef: string, cred: StoredCredential): Promise<void> {
  const kc = await getKeychain();
  // Encode kind+value together so the reader knows which Authorization scheme to use.
  await kc.set(serverAuthRef, CRED_ACCOUNT, JSON.stringify(cred));
}

export async function readCredential(serverAuthRef: string): Promise<StoredCredential | null> {
  const kc = await getKeychain();
  const raw = await kc.get(serverAuthRef, CRED_ACCOUNT);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as StoredCredential;
    if ((c.kind === 'apikey' || c.kind === 'jwt') && typeof c.value === 'string') return c;
    return null;
  } catch {
    return null;
  }
}

export async function clearCredential(serverAuthRef: string): Promise<void> {
  const kc = await getKeychain();
  await kc.delete(serverAuthRef, CRED_ACCOUNT);
}

/** The Authorization header value for a stored credential. */
export function authHeader(cred: StoredCredential): string {
  return cred.kind === 'jwt' ? `Bearer ${cred.value}` : `ApiKey ${cred.value}`;
}
