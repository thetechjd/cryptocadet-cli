// The keyed CollectorExecutor — the SELLER-side process that actually signs subscription
// pulls. The cryptocadet server never signs a fund-moving tx; it hands out cap-checked
// PENDING_EXECUTION pulls, and this component signs `transferFrom(buyer, payout, amount)`
// with the collector (spender) key, bounded on-chain by the buyer's approval.
//
// The executor re-checks the live allowance before signing (defense-in-depth over the
// server's own check) and refuses any instruction not addressed to this collector.

import { getAddress } from 'ethers';

export interface PullInstruction {
  id: string; // pull id (report keyed on this)
  subscriptionId: string;
  periodIndex: number;
  chainId: number;
  token: string; // lowercased
  from: string; // buyer wallet (owner of funds)
  to: string; // payout
  spender: string; // collector address that holds the approval
  amount: string; // base units, exactly one period
}

export type ExecOutcome =
  | { ok: true; txHash: string }
  | { ok: false; reason: string };

export interface ExecutorDeps {
  /** this collector's address (must equal the instruction's spender) */
  collectorAddress: string;
  /** the collector's chain (instructions on other chains are refused) */
  chainId: number;
  /** live remaining allowance owner→spender, base-unit string */
  readAllowance: (token: string, owner: string, spender: string) => Promise<string>;
  /** sign+broadcast transferFrom, resolving once confirmed; returns the tx hash */
  transferFrom: (token: string, from: string, to: string, amount: string) => Promise<{ txHash: string }>;
}

const big = (s: string) => BigInt(s);

function sameAddr(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/** Execute a single pull. Fail-closed: any mismatch/shortfall refuses without signing. */
export async function executePull(deps: ExecutorDeps, ins: PullInstruction): Promise<ExecOutcome> {
  if (ins.chainId !== deps.chainId) return { ok: false, reason: `wrong chain ${ins.chainId}` };
  if (!sameAddr(ins.spender, deps.collectorAddress)) return { ok: false, reason: 'instruction not addressed to this collector' };

  let amount: bigint;
  try {
    amount = big(ins.amount);
  } catch {
    return { ok: false, reason: 'bad amount' };
  }
  if (amount <= 0n) return { ok: false, reason: 'non-positive amount' };

  // Re-check the on-chain allowance ourselves before signing.
  let allowance: bigint;
  try {
    allowance = big(await deps.readAllowance(ins.token, ins.from, deps.collectorAddress));
  } catch (e) {
    return { ok: false, reason: `allowance read failed: ${(e as Error).message}` };
  }
  if (allowance < amount) return { ok: false, reason: 'insufficient allowance (approval revoked or exhausted)' };

  try {
    const { txHash } = await deps.transferFrom(ins.token, ins.from, ins.to, ins.amount);
    return { ok: true, txHash };
  } catch (e) {
    return { ok: false, reason: `transferFrom failed: ${(e as Error).message}` };
  }
}

export interface PullClient {
  pending(): Promise<PullInstruction[]>;
  report(id: string, result: { txHash: string } | { reason: string }): Promise<unknown>;
}

export interface TickSummary {
  claimed: number;
  executed: number;
  failed: number;
}

/** Claim all pending pulls once, execute, and report each result back to the server. */
export async function runCollectorOnce(client: PullClient, deps: ExecutorDeps): Promise<TickSummary> {
  const pending = await client.pending();
  const summary: TickSummary = { claimed: pending.length, executed: 0, failed: 0 };
  for (const ins of pending) {
    const outcome = await executePull(deps, ins);
    if (outcome.ok) {
      await client.report(ins.id, { txHash: outcome.txHash });
      summary.executed += 1;
    } else {
      await client.report(ins.id, { reason: outcome.reason });
      summary.failed += 1;
    }
  }
  return summary;
}
