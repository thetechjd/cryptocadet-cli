// The keyed TREASURY payout executor — the CryptoCadet OPERATOR process that pays sellers
// their earnings in USDC. The v4 server never signs: it moves earnings into PENDING payout
// rows; this process claims them (POST /v4/internal/payouts/claim), sends the USDC from the
// treasury wallet, and reports the tx hash back.
//
// Fail-closed: a payout on the wrong chain, in an unexpected token, to a malformed address,
// above the per-payout safety cap, or exceeding the treasury balance is refused WITHOUT
// signing. A transfer that was broadcast but not confirmed is reported as a failure that
// carries the tx hash, so an operator checks the chain before reversing it (the server never
// retries a claimed payout on its own).

import { getAddress } from 'ethers';

export interface PayoutInstruction {
  id: string;
  accountId: string;
  chainId: number;
  token: string; // lowercased USDC address
  to: string; // seller payout address (EIP-55)
  amount: string; // micro-USD == USDC base units
  status: string; // CLAIMED when handed to us
}

export type PayoutOutcome = { ok: true; txHash: string } | { ok: false; reason: string };

export interface TreasuryDeps {
  chainId: number;
  /** the only token this treasury pays in (lowercased) */
  token: string;
  /** refuse any single payout above this many base units */
  maxPerPayout: bigint;
  /** live treasury balance of `token`, base-unit string */
  readBalance: (token: string) => Promise<string>;
  /** sign + broadcast transfer(to, amount) and wait for confirmation; returns the tx hash.
   *  Must throw an error whose message includes the hash if it was broadcast but not confirmed. */
  transfer: (token: string, to: string, amount: string) => Promise<{ txHash: string }>;
}

export async function executePayout(deps: TreasuryDeps, ins: PayoutInstruction): Promise<PayoutOutcome> {
  if (ins.chainId !== deps.chainId) return { ok: false, reason: `wrong chain ${ins.chainId}` };
  if (ins.token.toLowerCase() !== deps.token.toLowerCase()) return { ok: false, reason: `unexpected token ${ins.token}` };
  let to: string;
  try {
    to = getAddress(ins.to);
  } catch {
    return { ok: false, reason: 'malformed payout address' };
  }
  let amount: bigint;
  try {
    amount = BigInt(ins.amount);
  } catch {
    return { ok: false, reason: 'bad amount' };
  }
  if (amount <= 0n) return { ok: false, reason: 'non-positive amount' };
  if (amount > deps.maxPerPayout) return { ok: false, reason: `amount ${ins.amount} exceeds the treasury per-payout cap` };

  let balance: bigint;
  try {
    balance = BigInt(await deps.readBalance(deps.token));
  } catch (e) {
    return { ok: false, reason: `balance read failed: ${(e as Error).message}` };
  }
  if (balance < amount) return { ok: false, reason: `treasury balance ${balance} below payout ${amount}` };

  try {
    const { txHash } = await deps.transfer(deps.token, to, ins.amount);
    return { ok: true, txHash };
  } catch (e) {
    return { ok: false, reason: `transfer failed: ${(e as Error).message}` };
  }
}

export interface TreasuryClient {
  claim(limit: number): Promise<PayoutInstruction[]>;
  report(id: string, result: { txHash: string } | { reason: string }): Promise<unknown>;
}

export interface TreasuryTick {
  claimed: number;
  sent: number;
  failed: number;
}

/** Claim a batch of payouts, pay each, and report every result back to the server. */
export async function runTreasuryOnce(client: TreasuryClient, deps: TreasuryDeps, limit = 10): Promise<TreasuryTick> {
  const claimed = await client.claim(limit);
  const tick: TreasuryTick = { claimed: claimed.length, sent: 0, failed: 0 };
  for (const ins of claimed) {
    const outcome = await executePayout(deps, ins);
    if (outcome.ok) {
      await client.report(ins.id, { txHash: outcome.txHash });
      tick.sent += 1;
    } else {
      await client.report(ins.id, { reason: outcome.reason });
      tick.failed += 1;
    }
  }
  return tick;
}
