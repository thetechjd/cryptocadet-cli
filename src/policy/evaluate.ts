// THE LOAD-BEARING FUNCTION.
//
// Every signing decision passes through evaluate() before any signature is produced.
// It is the entire defense: there is no smart account and no on-chain caveat enforcer
// behind it. It is fail-closed — any error, any missing field, any unparseable amount
// returns DENY.
//
// evaluate() is PURE and SYNCHRONOUS. All I/O (balance reads, ledger reads) happens
// before it and is passed in via PolicyContext. This makes deny-by-default impossible
// to skip via an async failure, and makes the function trivially testable.

import { getAddress } from 'ethers';
import type { Policy } from '../types/policy.js';
import type { QuoteForPolicy } from '../types/quote.js';

export type Decision =
  | { allow: true }
  | { allow: false; reason: string }
  | { allow: false; reason: string; escalate: true }; // needs human confirm

export interface PolicyContext {
  policy: Policy;
  walletBalance: (token: string) => string; // base units, on-chain read
  spentLast24h: (token: string) => string; // base units, from ledger
  isQuoteSeen: (quoteId: string) => boolean; // idempotency
}

const big = (s: string) => BigInt(s);

export function evaluate(q: QuoteForPolicy, ctx: PolicyContext): Decision {
  const p = ctx.policy;

  // 0. Chain must match exactly.
  if (q.chainId !== p.chainId)
    return { allow: false, reason: `wrong chain ${q.chainId}` };

  // 1. Token must be on the allowlist.
  const token = q.token.toLowerCase();
  const allowed = p.allowlist[token];
  if (!allowed) return { allow: false, reason: `token not allowlisted ${token}` };

  // v4: fee-on-transfer tokens are rejected at allowlist time. If one slips into the
  // allowlist, refuse here too — settlement math would otherwise under-deliver.
  if (allowed.feeOnTransfer)
    return { allow: false, reason: `fee-on-transfer token not supported ${token}` };

  // 2. Recipient must be on the payout allowlist. Normalize to checksum to avoid case
  //    tricks, compare lowercased.
  let recip: string;
  try {
    recip = getAddress(q.recipient).toLowerCase();
  } catch {
    return { allow: false, reason: 'malformed recipient' };
  }
  if (!p.recipients.map((r) => r.toLowerCase()).includes(recip))
    return { allow: false, reason: `recipient not allowlisted ${recip}` };

  // 3. Amount must parse and be positive.
  let amt: bigint;
  try {
    amt = big(q.amount);
  } catch {
    return { allow: false, reason: 'bad amount' };
  }
  if (amt <= 0n) return { allow: false, reason: 'non-positive amount' };

  // 4. Per-tx cap.
  const perTx = p.perTxCap[token];
  if (!perTx) return { allow: false, reason: 'no per-tx cap configured' };
  if (amt > big(perTx)) return { allow: false, reason: 'exceeds per-tx cap' };

  // 5. Daily rolling cap.
  const daily = p.dailyCap[token];
  if (!daily) return { allow: false, reason: 'no daily cap configured' };
  const spent24 = ctx.spentLast24h(token) as string | undefined;
  if (spent24 === undefined)
    return { allow: false, reason: 'cannot read 24h spend' };
  let spent24n: bigint;
  try {
    spent24n = big(spent24);
  } catch {
    return { allow: false, reason: 'cannot read 24h spend' };
  }
  if (spent24n + amt > big(daily))
    return { allow: false, reason: 'exceeds daily cap' };

  // 6. Spendable = balance - subscription reserve. Per-call must NEVER cross the
  //    reserve. This is the subscription-floor invariant.
  const reserve = big(p.subscriptionReserve[token] ?? '0');
  let balance: bigint;
  try {
    balance = big(ctx.walletBalance(token));
  } catch {
    return { allow: false, reason: 'cannot read wallet balance' };
  }
  const spendable = balance - reserve;
  if (spendable < 0n) return { allow: false, reason: 'balance below reserve' };
  if (amt > spendable)
    return { allow: false, reason: 'would cross subscription reserve' };

  // 7. Idempotency: a quote already acted on is a no-op, not a re-spend.
  if (ctx.isQuoteSeen(q.quoteId))
    return { allow: false, reason: 'quote already processed' };

  // 8. Escalation: above threshold, allow only with human confirmation.
  const escThreshold = p.requireHumanAboveTx[token];
  if (escThreshold && amt > big(escThreshold))
    return { allow: false, reason: 'above human-confirm threshold', escalate: true };

  return { allow: true };
}
