// The credits-rail agent token (`ccx_agent_…`): spends the OWNER's card-funded credits at
// CryptoCadet gateway routes, capped server-side per call / per 24h. A third secret with
// its own blast radius (bounded by those caps), so it gets its own keychain entry, apart
// from the wallet data key and the server credential. Written ONLY by the human-only
// `agent-token:create`; the agent surface can use it (fetch_paid) but never read it.

import { getKeychain } from '../custody/keychain.js';

const ACCOUNT = 'credits-agent-token';
export const AGENT_TOKEN_PREFIX = 'ccx_agent_';

/** Keychain service id for the agent token, derived like serverAuthRef. */
export const agentTokenRef = (keychainRef: string): string => `${keychainRef}-agent-token`;

export async function storeAgentToken(ref: string, token: string): Promise<void> {
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) throw new Error(`agent token must start with ${AGENT_TOKEN_PREFIX}`);
  await (await getKeychain()).set(ref, ACCOUNT, token);
}

export async function readAgentToken(ref: string): Promise<string | null> {
  const t = await (await getKeychain()).get(ref, ACCOUNT);
  return t && t.startsWith(AGENT_TOKEN_PREFIX) ? t : null;
}

export async function clearAgentToken(ref: string): Promise<void> {
  await (await getKeychain()).delete(ref, ACCOUNT);
}
