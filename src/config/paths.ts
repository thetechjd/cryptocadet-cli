// On-disk layout. Root: ~/.cryptocadet/. Nothing here except keys, policy, and the
// pending-tx ledger. No products, no prices, no preferences, no cached server state —
// caching server state locally reintroduces the divergence we designed out.
//
//   ~/.cryptocadet/
//     agent.key.enc    # encrypted agent-wallet private key
//     policy.json      # local-only enforcement policy
//     ledger.sqlite    # pending-tx + idempotency ledger
//     config.json      # non-secret: rpc url, chain id, server base url, keychain ref

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Allow override for tests / multi-profile via CRYPTOCADET_HOME. */
export function rootDir(): string {
  return process.env.CRYPTOCADET_HOME ?? join(homedir(), '.cryptocadet');
}

export const paths = {
  root: rootDir,
  keyEnc: () => join(rootDir(), 'agent.key.enc'),
  collectorKeyEnc: () => join(rootDir(), 'collector.key.enc'),
  policy: () => join(rootDir(), 'policy.json'),
  ledger: () => join(rootDir(), 'ledger.sqlite'),
  config: () => join(rootDir(), 'config.json'),
} as const;
