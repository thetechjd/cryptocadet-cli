// Rotate — replace the agent keypair so a leaked key's signing path becomes unusable.
//
// A raw key, once readable by a networked agent process, can never be un-exposed.
// Revocation is therefore rotation PLUS moving the funds off the old wallet. Rotation
// invalidates any active ERC-20 pull subscription: the user must re-grant approvals from
// the new wallet.
//
// SAFE ORDERING (the reason this is not a one-liner): the new key is generated in memory
// and the OLD wallet is swept FIRST — while the old key is still the committed key on
// disk — and only then is the new key persisted. So if the sweep fails (no gas, RPC
// error, revert), nothing was rotated, the old key is intact, and funds are safe to
// retry. The alternative (rotate then sweep) would strand funds behind a destroyed key.

import { Wallet, getAddress, type JsonRpcProvider } from 'ethers';
import { unlockAgentPrivateKey, storeAgentKey } from '../custody/keystore.js';
import { loadConfig, saveConfig } from '../config/config.js';
import { makeWallet } from '../chain/provider.js';
import { sweep, type SweepReport } from './sweep.js';

export interface RotateReport {
  oldAddress: string;
  newAddress: string;
  keychainRef: string;
  /** The sweep result, or null if funds were not moved. */
  swept: SweepReport | null;
  /** Where funds were swept, or null if not swept. */
  sweptTo: string | null;
}

export interface RotateOptions {
  provider: JsonRpcProvider;
  /** Move the old wallet's funds off the old key. */
  sweep: boolean;
  /** Sweep destination. Omit to send funds to the freshly-generated NEW agent wallet. */
  sweepTo?: string | undefined;
}

/** Rotate the agent keypair, optionally rescuing the old wallet's funds first. See the
 *  file header for the ordering guarantee. Returns what changed and what (if anything) moved. */
export async function rotateAgent(opts: RotateOptions): Promise<RotateReport> {
  const cfg = loadConfig();
  const oldAddress = cfg.agentAddress;

  // Unlock the old key into memory. This is the last handle on the old wallet — after we
  // persist the new key below, the old key file is gone, but this in-memory signer stays
  // valid for the sweep because we sweep BEFORE committing the new key.
  const oldWallet = makeWallet(await unlockAgentPrivateKey(cfg.keychainRef), opts.provider);

  // Generate the replacement in memory (not yet stored).
  const newWallet = Wallet.createRandom();
  const newAddress = getAddress(newWallet.address).toLowerCase();
  const dest = opts.sweepTo ?? newAddress;

  // Rescue funds while the old key is still the committed one — a failure here aborts
  // before any rotation, leaving the wallet exactly as it was.
  let swept: SweepReport | null = null;
  if (opts.sweep) swept = await sweep(opts.provider, oldWallet, dest);

  // Commit the rotation only after the (optional) sweep succeeded.
  await storeAgentKey(cfg.keychainRef, newWallet.privateKey);
  saveConfig({ ...cfg, agentAddress: newAddress });

  return { oldAddress, newAddress, keychainRef: cfg.keychainRef, swept, sweptTo: opts.sweep ? dest : null };
}
