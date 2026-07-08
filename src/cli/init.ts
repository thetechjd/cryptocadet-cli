// `cryptocadet init` — generates the agent keypair (CryptoCadet's code, CryptoCadet's
// process, against ~/.cryptocadet/), encrypts it at rest, stores the data key in the OS
// keychain, writes non-secret config.json, and creates a deny-everything policy.json.
//
// RDK never generates or handles keys; it may install this package and invoke this verb,
// but key generation is CryptoCadet's. The user's MAIN wallet key is NEVER handled here.

import { randomBytes } from 'node:crypto';
import { generateAndStoreAgentKey } from '../custody/keystore.js';
import { saveConfig, configExists, type Config } from '../config/config.js';
import { initPolicy } from './human-verbs.js';

export interface InitArgs {
  chainId: 8453 | 84532;
  rpcUrl: string;
  serverBaseUrl: string;
  serverQuotePubKey: string; // base64 raw Ed25519
}

export interface InitReport {
  agentAddress: string;
  keychainRef: string;
  chainId: 8453 | 84532;
}

export async function init(args: InitArgs): Promise<InitReport> {
  if (configExists()) throw new Error('config.json already exists; refusing to overwrite (use rotate to change keys)');
  const suffix = randomBytes(8).toString('hex');
  const keychainRef = `cryptocadet-agent-${suffix}`;
  // The server credential is a DIFFERENT secret with a different blast radius: separate
  // keychain entry from the wallet key.
  const serverAuthRef = `cryptocadet-server-${suffix}`;
  const { address } = await generateAndStoreAgentKey(keychainRef);

  const config: Config = {
    chainId: args.chainId,
    rpcUrl: args.rpcUrl,
    serverBaseUrl: args.serverBaseUrl,
    serverQuotePubKey: args.serverQuotePubKey,
    keychainRef,
    serverAuthRef,
    agentAddress: address,
  };
  saveConfig(config);
  initPolicy(args.chainId);

  return { agentAddress: address, keychainRef, chainId: args.chainId };
}
