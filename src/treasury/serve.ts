// Wires the live treasury signer: unlock the treasury wallet, build the on-chain deps, and
// run the payout loop against the server. OPERATOR-ONLY (CryptoCadet ops pays sellers);
// buyers and sellers never need this.

import { loadConfig, saveConfig } from '../config/config.js';
import { makeProvider, makeWallet, confirmationDepth } from '../chain/provider.js';
import { generateAndStoreTreasuryKey, unlockTreasuryPrivateKey } from '../custody/keystore.js';
import { tokenBalance, sendPayoutTransfer } from '../chain/erc20.js';
import { treasuryClient } from './internal-client.js';
import { runTreasuryOnce, type TreasuryClient, type TreasuryDeps, type TreasuryTick } from './executor.js';

export interface TreasuryInitReport {
  treasuryAddress: string;
  treasuryKeychainRef: string;
}

/** Generate the treasury wallet and record it in config. Fund it with USDC + gas ETH. */
export async function treasuryInit(): Promise<TreasuryInitReport> {
  const cfg = loadConfig();
  const keychainRef = `cryptocadet-treasury-${cfg.keychainRef.split('-').pop() ?? 'x'}`;
  const { address } = await generateAndStoreTreasuryKey(keychainRef);
  saveConfig({ ...cfg, treasuryKeychainRef: keychainRef, treasuryAddress: address });
  return { treasuryAddress: address, treasuryKeychainRef: keychainRef };
}

/** Per-payout safety cap (base units). Default $1,000; raise deliberately via env. */
export function maxPerPayoutFromEnv(env: NodeJS.ProcessEnv = process.env): bigint {
  const raw = env.CRYPTOCADET_TREASURY_MAX_PAYOUT ?? '1000000000';
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('CRYPTOCADET_TREASURY_MAX_PAYOUT must be a positive integer (base units)');
  return BigInt(raw);
}

async function buildDeps(): Promise<{ deps: TreasuryDeps; client: TreasuryClient }> {
  const cfg = loadConfig();
  if (!cfg.treasuryKeychainRef || !cfg.treasuryAddress) {
    throw new Error('treasury not initialized (run `cryptocadet treasury:init`)');
  }
  const secret = process.env.CRYPTOCADET_INTERNAL_SECRET;
  if (!secret) throw new Error('set CRYPTOCADET_INTERNAL_SECRET in the environment to run the treasury');
  const token = process.env.CRYPTOCADET_PAYOUT_TOKEN?.toLowerCase();
  if (!token || !/^0x[0-9a-f]{40}$/.test(token)) {
    throw new Error('set CRYPTOCADET_PAYOUT_TOKEN to the USDC address payouts are made in (must match the server PAYOUT_TOKEN)');
  }

  const provider = makeProvider(cfg);
  const wallet = makeWallet(await unlockTreasuryPrivateKey(cfg.treasuryKeychainRef), provider);
  const confirmations = confirmationDepth(cfg.chainId, cfg.confirmationDepth);
  const treasury = cfg.treasuryAddress;

  const deps: TreasuryDeps = {
    chainId: cfg.chainId,
    token,
    maxPerPayout: maxPerPayoutFromEnv(),
    readBalance: (t) => tokenBalance(provider, t, treasury),
    transfer: async (t, to, amount) => {
      const tx = await sendPayoutTransfer(wallet, t, to, amount); // <- the ONLY treasury signing
      try {
        await tx.wait(confirmations);
      } catch (e) {
        // Broadcast but unconfirmed: say so with the hash so ops can check before reversing.
        throw new Error(`broadcast ${tx.hash} but not confirmed: ${(e as Error).message}`);
      }
      return { txHash: tx.hash };
    },
  };
  return { deps, client: treasuryClient(cfg.serverBaseUrl, secret) };
}

/** Run one payout pass (cron-friendly). */
export async function treasuryServeOnce(): Promise<TreasuryTick> {
  const { deps, client } = await buildDeps();
  return runTreasuryOnce(client, deps);
}

/** Run continuously on an interval until stopped. Returns a stop() function. Ticks never
 *  overlap, so a slow confirmation can't make two passes race each other. */
export async function treasuryServeLoop(intervalMs: number, onTick?: (t: TreasuryTick) => void): Promise<() => void> {
  const { deps, client } = await buildDeps();
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runTreasuryOnce(client, deps)
      .then((t) => onTick?.(t))
      .catch((e) => console.error(`[treasury] tick failed: ${(e as Error).message}`))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
