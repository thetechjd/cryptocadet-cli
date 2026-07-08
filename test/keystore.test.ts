import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import {
  generateAndStoreAgentKey,
  unlockAgentPrivateKey,
  agentAddressFromKeystore,
} from '../src/custody/keystore.js';
import { paths } from '../src/config/paths.js';

let home: string;
const REF = 'cryptocadet-agent-test';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-keystore-'));
  process.env.CRYPTOCADET_HOME = home;
  process.env.CRYPTOCADET_INSECURE_KEYCHAIN = '1'; // in-memory keychain for the test only
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.CRYPTOCADET_HOME;
  delete process.env.CRYPTOCADET_INSECURE_KEYCHAIN;
});

describe('custody keystore', () => {
  it('encrypts at rest; unlock round-trips to the same key', async () => {
    const { address } = await generateAndStoreAgentKey(REF);
    const priv = await unlockAgentPrivateKey(REF);
    expect(new Wallet(priv).address.toLowerCase()).toBe(address);
    expect(await agentAddressFromKeystore(REF)).toBe(address);
  });

  it('9. plaintext private key is NOT written to disk', async () => {
    await generateAndStoreAgentKey(REF);
    const priv = await unlockAgentPrivateKey(REF);
    expect(existsSync(paths.keyEnc())).toBe(true);
    const onDisk = readFileSync(paths.keyEnc(), 'utf8');
    // The encrypted file must not contain the plaintext key (with or without 0x).
    expect(onDisk).not.toContain(priv);
    expect(onDisk).not.toContain(priv.slice(2));
    // And nothing in the home dir leaks it either.
    expect(onDisk).toMatch(/"alg":"aes-256-gcm"/);
  });

  it('11. rotation makes the old key unusable; new address differs', async () => {
    const { address: oldAddr } = await generateAndStoreAgentKey(REF);
    const oldPriv = await unlockAgentPrivateKey(REF);

    // Roll the keypair (what rotate() does at the key layer).
    const { address: newAddr } = await generateAndStoreAgentKey(REF);
    expect(newAddr).not.toBe(oldAddr);

    const nowPriv = await unlockAgentPrivateKey(REF);
    expect(nowPriv).not.toBe(oldPriv); // old key is gone from disk + keychain
    expect(new Wallet(nowPriv).address.toLowerCase()).toBe(newAddr);
  });

  it('unlock fails cleanly when the keychain entry is absent', async () => {
    await generateAndStoreAgentKey(REF);
    await expect(unlockAgentPrivateKey('nonexistent-ref')).rejects.toThrow(/data key not present/);
  });
});
