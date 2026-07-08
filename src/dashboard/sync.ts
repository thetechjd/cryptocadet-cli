// dashboard:sync — push READ-ONLY display snapshots (policy, balances, low-float alerts)
// to the server so the dashboard can render them. The server is never authoritative for
// policy or balances; this is a one-way display feed from the key-holding machine. No key
// material leaves the client — only the public policy view, on-chain balances, and the
// agent's public address.

import { loadConfig } from '../config/config.js';
import { loadPolicy } from '../config/policy-store.js';
import { makeProvider } from '../chain/provider.js';
import { tokenBalance } from '../chain/erc20.js';
import { makeServerClient } from '../cli/seller.js';
import type { Policy } from '../types/policy.js';
import type { BalanceSnapshot, TopupAlertInput } from '../server/client.js';

const big = (s: string) => BigInt(s);

/** Build per-token balance snapshots from the policy allowlist + freshly-read balances. */
export function buildBalanceSnapshots(policy: Policy, balances: Record<string, string>): BalanceSnapshot[] {
  return Object.entries(policy.allowlist).map(([token, meta]) => {
    const balance = balances[token] ?? '0';
    const reserve = policy.subscriptionReserve[token] ?? '0';
    const spendableRaw = big(balance) - big(reserve);
    return {
      token,
      symbol: meta.symbol,
      decimals: meta.decimals,
      balance,
      reserve,
      spendable: (spendableRaw < 0n ? 0n : spendableRaw).toString(),
    };
  });
}

/** A token whose balance can't even cover its subscription reserve is low-float; the
 *  shortfall is how much must be topped up to reach the reserve floor. */
export function buildTopupAlerts(snapshots: BalanceSnapshot[], agentAddress: string): TopupAlertInput[] {
  const alerts: TopupAlertInput[] = [];
  for (const s of snapshots) {
    const deficit = big(s.reserve) - big(s.balance);
    if (deficit > 0n) {
      alerts.push({ token: s.token, symbol: s.symbol, agentAddress, shortfall: deficit.toString() });
    }
  }
  return alerts;
}

export interface SyncReport {
  agentAddress: string;
  tokens: number;
  alerts: number;
  updatedAt: number;
}

/** Read balances on-chain, build the snapshots, and push policy + balances + alerts. */
export async function dashboardSync(): Promise<SyncReport> {
  const cfg = loadConfig();
  const policy = loadPolicy();
  const provider = makeProvider(cfg);

  const balances: Record<string, string> = {};
  for (const token of Object.keys(policy.allowlist)) {
    balances[token] = await tokenBalance(provider, token, cfg.agentAddress);
  }

  const snapshots = buildBalanceSnapshots(policy, balances);
  const alerts = buildTopupAlerts(snapshots, cfg.agentAddress);

  const server = await makeServerClient();
  const policyRes = await server.putPolicy(policy);
  await server.putBalances(snapshots);
  await server.raiseTopupAlerts(alerts);

  return { agentAddress: cfg.agentAddress, tokens: snapshots.length, alerts: alerts.length, updatedAt: policyRes.updatedAt };
}
