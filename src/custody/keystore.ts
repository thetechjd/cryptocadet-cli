// Custody at rest. The agent private key is encrypted with AES-256-GCM under a 32-byte
// data key that lives ONLY in the OS keychain. agent.key.enc on disk is useless without
// the keychain entry.
//
// Compromise cost, documented to the user: anything that can read the signer process's
// memory while it runs can obtain the agent key. This is WHY the float is bounded — the
// blast radius is the float, never the main wallet. There is NO code path in this
// component that references a main wallet private key.

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { Wallet, getAddress } from 'ethers';
import { paths } from '../config/paths.js';
import { ensureRoot } from '../config/config.js';
import { getKeychain, KEYCHAIN_ACCOUNT, type Keychain } from './keychain.js';

interface EncFile {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string; // base64, 12 bytes
  tag: string; // base64, 16 bytes
  ct: string; // base64 ciphertext of the 0x-prefixed private key utf8 string
}

const DATA_KEY_BYTES = 32;

function newDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES);
}

function encrypt(privKeyHex: string, dataKey: Buffer): EncFile {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([cipher.update(privKeyHex, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

function decrypt(file: EncFile, dataKey: Buffer): string {
  if (file.alg !== 'aes-256-gcm') throw new Error('keystore: unsupported alg');
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(file.ct, 'base64')), decipher.final()]);
  const hex = pt.toString('utf8');
  pt.fill(0);
  return hex;
}

export interface GeneratedAgentKey {
  address: string; // lowercased
  keychainRef: string;
}

// ── Generic keystore core (parameterized by the on-disk enc-file path) ────────
// The same at-rest scheme backs BOTH the buyer agent wallet (agent.key.enc) and the
// seller-side collector wallet (collector.key.enc): a distinct keychain data key per file.

async function storeKey(keychainRef: string, encPath: string, privKeyHex: string): Promise<GeneratedAgentKey> {
  ensureRoot();
  const dataKey = newDataKey();
  try {
    const enc = encrypt(privKeyHex, dataKey);
    const kc = await getKeychain();
    await kc.set(keychainRef, KEYCHAIN_ACCOUNT, dataKey.toString('base64'));
    writeFileSync(encPath, JSON.stringify(enc), { mode: 0o600 });
    chmodSync(encPath, 0o600);
    return { address: new Wallet(privKeyHex).address.toLowerCase(), keychainRef };
  } finally {
    dataKey.fill(0);
  }
}

async function generateAndStoreKey(keychainRef: string, encPath: string): Promise<GeneratedAgentKey> {
  return storeKey(keychainRef, encPath, Wallet.createRandom().privateKey);
}

async function unlockPrivateKey(keychainRef: string, encPath: string, kc?: Keychain): Promise<string> {
  if (!existsSync(encPath)) throw new Error(`keystore: ${encPath} not found`);
  const chain = kc ?? (await getKeychain());
  const b64 = await chain.get(keychainRef, KEYCHAIN_ACCOUNT);
  if (!b64) throw new Error('keystore: data key not present in OS keychain');
  const dataKey = Buffer.from(b64, 'base64');
  try {
    const file = JSON.parse(readFileSync(encPath, 'utf8')) as EncFile;
    return decrypt(file, dataKey);
  } finally {
    dataKey.fill(0);
  }
}

// ── Agent (buyer) wallet — unchanged public API ───────────────────────────────

/** Generate a fresh agent keypair, encrypt at rest, stash the data key in the keychain. */
export function generateAndStoreAgentKey(keychainRef: string): Promise<GeneratedAgentKey> {
  return generateAndStoreKey(keychainRef, paths.keyEnc());
}

/** Persist a SPECIFIC agent private key at rest (under a fresh data key). Used by rotate,
 *  which generates the new key in memory and sweeps the old wallet to it BEFORE committing
 *  here — so a failed sweep can't strand funds behind an already-destroyed old key. */
export function storeAgentKey(keychainRef: string, privKeyHex: string): Promise<GeneratedAgentKey> {
  return storeKey(keychainRef, paths.keyEnc(), privKeyHex);
}

/** Re-encrypt the agent key under a FRESH data key (rotate the data key, keep the wallet). */
export async function rekeyDataKey(keychainRef: string): Promise<void> {
  const priv = await unlockAgentPrivateKey(keychainRef);
  const dataKey = newDataKey();
  try {
    const enc = encrypt(priv, dataKey);
    const kc = await getKeychain();
    await kc.set(keychainRef, KEYCHAIN_ACCOUNT, dataKey.toString('base64'));
    writeFileSync(paths.keyEnc(), JSON.stringify(enc), { mode: 0o600 });
    chmodSync(paths.keyEnc(), 0o600);
  } finally {
    dataKey.fill(0);
  }
}

/** Read the data key from the OS keychain (one OS authorization) and decrypt the agent
 *  private key into memory. The plaintext key is NEVER written to disk. */
export function unlockAgentPrivateKey(keychainRef: string, kc?: Keychain): Promise<string> {
  return unlockPrivateKey(keychainRef, paths.keyEnc(), kc);
}

/** Derive the agent wallet address without exposing the private key to the caller. */
export async function agentAddressFromKeystore(keychainRef: string): Promise<string> {
  const priv = await unlockAgentPrivateKey(keychainRef);
  return getAddress(new Wallet(priv).address).toLowerCase();
}

// ── Collector (seller-side spender) wallet — separate key + enc file ──────────

/** Generate the collector keypair (the spender address buyers approve for pulls). */
export function generateAndStoreCollectorKey(keychainRef: string): Promise<GeneratedAgentKey> {
  return generateAndStoreKey(keychainRef, paths.collectorKeyEnc());
}

/** Unlock the collector private key for signing transferFrom. */
export function unlockCollectorPrivateKey(keychainRef: string, kc?: Keychain): Promise<string> {
  return unlockPrivateKey(keychainRef, paths.collectorKeyEnc(), kc);
}
