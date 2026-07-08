// Wires the live collector: unlock the collector wallet, build the on-chain deps, and run
// the pull loop against the server. Signing happens ONLY here (the seller-side keyed
// process) — never in the cryptocadet server.

import { loadConfig, saveConfig } from '../config/config.js';
import { makeProvider, makeWallet, confirmationDepth } from '../chain/provider.js';
import { generateAndStoreCollectorKey, unlockCollectorPrivateKey } from '../custody/keystore.js';
import { tokenAllowance, sendTransferFrom } from '../chain/erc20.js';
import { collectorClient } from './internal-client.js';
import { runCollectorOnce, type ExecutorDeps, type PullClient, type TickSummary } from './executor.js';

export interface CollectorInitReport {
  collectorAddress: string;
  collectorKeychainRef: string;
}

/** Generate the collector wallet and record it in config. Buyers approve this address. */
export async function collectorInit(): Promise<CollectorInitReport> {
  const cfg = loadConfig();
  const keychainRef = `cryptocadet-collector-${cfg.keychainRef.split('-').pop() ?? 'x'}`;
  const { address } = await generateAndStoreCollectorKey(keychainRef);
  saveConfig({ ...cfg, collectorKeychainRef: keychainRef, collectorAddress: address });
  return { collectorAddress: address, collectorKeychainRef: keychainRef };
}

async function buildDeps(): Promise<{ deps: ExecutorDeps; client: PullClient }> {
  const cfg = loadConfig();
  if (!cfg.collectorKeychainRef || !cfg.collectorAddress) {
    throw new Error('collector not initialized (run `cryptocadet collector:init`)');
  }
  const secret = process.env.CRYPTOCADET_INTERNAL_SECRET;
  if (!secret) throw new Error('set CRYPTOCADET_INTERNAL_SECRET in the environment to run the collector');

  const provider = makeProvider(cfg);
  const wallet = makeWallet(await unlockCollectorPrivateKey(cfg.collectorKeychainRef), provider);
  const confirmations = confirmationDepth(cfg.chainId);

  const deps: ExecutorDeps = {
    collectorAddress: cfg.collectorAddress,
    chainId: cfg.chainId,
    readAllowance: (token, owner, spender) => tokenAllowance(provider, token, owner, spender),
    transferFrom: async (token, from, to, amount) => {
      const tx = await sendTransferFrom(wallet, token, from, to, amount); // <- the ONLY collector signing
      await tx.wait(confirmations);
      return { txHash: tx.hash };
    },
  };
  return { deps, client: collectorClient(cfg.serverBaseUrl, secret) };
}

/** Run one collection pass (cron-friendly). */
export async function collectorServeOnce(): Promise<TickSummary> {
  const { deps, client } = await buildDeps();
  return runCollectorOnce(client, deps);
}

/** Run continuously on an interval until stopped. Returns a stop() function. */
export async function collectorServeLoop(
  intervalMs: number,
  onTick?: (s: TickSummary) => void,
): Promise<() => void> {
  const { deps, client } = await buildDeps();
  const tick = () =>
    runCollectorOnce(client, deps)
      .then((s) => onTick?.(s))
      .catch((e) => console.error(`[collector] tick failed: ${(e as Error).message}`));
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
