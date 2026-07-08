// Rotate — replace the agent keypair so a leaked key's signing path becomes unusable.
//
// A raw key, once readable by a networked agent process, can never be un-exposed.
// Revocation is therefore rotation PLUS sweep. Rotate alone does NOT move funds; pair it
// with sweep (the CLI exposes `rotate --and-sweep`). Rotation invalidates any active
// ERC-20 pull subscription: the user must re-grant approvals from the new wallet.

import { generateAndStoreAgentKey } from '../custody/keystore.js';
import { loadConfig, saveConfig } from '../config/config.js';

export interface RotateReport {
  oldAddress: string;
  newAddress: string;
  keychainRef: string;
}

/** Generate a fresh agent keypair under a fresh data key, update config with the new
 *  address. The old encrypted key file is overwritten; the old private key is gone. */
export async function rotate(): Promise<RotateReport> {
  const cfg = loadConfig();
  const oldAddress = cfg.agentAddress;
  // Reuse the keychain service id; generateAndStoreAgentKey rolls the data key under it
  // and overwrites agent.key.enc with the new wallet's encrypted key.
  const { address } = await generateAndStoreAgentKey(cfg.keychainRef);
  saveConfig({ ...cfg, agentAddress: address });
  return { oldAddress, newAddress: address, keychainRef: cfg.keychainRef };
}
