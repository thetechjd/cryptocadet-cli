// Non-secret client config. Holds NO key material — only references and endpoints.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths, rootDir } from './paths.js';

export interface Config {
  /** Base mainnet 8453, Base Sepolia testnet 84532. Must match policy.chainId. */
  chainId: 8453 | 84532;
  /** JSON-RPC endpoint for Base / Base Sepolia. */
  rpcUrl: string;
  /** cryptocadet server base url, e.g. https://api.cryptocadet.example */
  serverBaseUrl: string;
  /** Pinned Ed25519 quote-signing PUBLIC key (base64). The client verifies serverSig
   *  against this. NOT a wallet key. */
  serverQuotePubKey: string;
  /** OS-keychain service id under which the at-rest data key is stored. */
  keychainRef: string;
  /** OS-keychain service id for the SERVER credential (API key / JWT). A DIFFERENT secret
   *  with a different blast radius than the wallet key — kept in a separate keychain entry. */
  serverAuthRef: string;
  /** Lowercased agent hot-wallet address (derived from the key; cached for read paths). */
  agentAddress: string;
  /** OS-keychain service id for the SELLER-side collector wallet (set by `collector:init`). */
  collectorKeychainRef?: string;
  /** Lowercased collector (spender) address buyers approve for subscription pulls. */
  collectorAddress?: string;
}

export function ensureRoot(): void {
  const dir = rootDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function configExists(): boolean {
  return existsSync(paths.config());
}

export function loadConfig(): Config {
  const raw = readFileSync(paths.config(), 'utf8');
  const c = JSON.parse(raw) as Config;
  if (c.chainId !== 8453 && c.chainId !== 84532)
    throw new Error(`config: unsupported chainId ${c.chainId}`);
  for (const k of ['rpcUrl', 'serverBaseUrl', 'serverQuotePubKey', 'keychainRef', 'agentAddress'] as const) {
    if (!c[k]) throw new Error(`config: missing ${k}`);
  }
  // serverAuthRef was added in instruction 02; derive a stable default for older configs.
  if (!c.serverAuthRef) c.serverAuthRef = `${c.keychainRef}-server-cred`;
  return c;
}

export function saveConfig(c: Config): void {
  ensureRoot();
  const file = paths.config();
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
