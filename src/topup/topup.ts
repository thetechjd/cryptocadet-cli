// Top-up is a HUMAN action. There is NO auto-drain from the main wallet — this module
// only computes a shortfall and emits an approval request. Two supported modes:
//   - alert-and-approve: emit a low-float event; the human approves a transfer from the
//     main wallet to the agent wallet out of band.
//   - batch pre-fund: the human funds the agent wallet ahead of time; the agent runs dry.
// Top-up is multi-asset (per-token amounts on Base); there is no cross-token conversion.

import type { Policy } from '../types/policy.js';

const big = (s: string) => BigInt(s);

export interface TopupTarget {
  token: string;
  /** desired total balance for this token, base units */
  target: string;
}

export interface TopupRequestLine {
  token: string;
  symbol: string;
  balance: string;
  reserve: string;
  spendable: string;
  /** how much to add to reach the desired target (0 if already met) */
  shortfall: string;
}

export interface TopupRequest {
  agentAddress: string;
  lines: TopupRequestLine[];
  /** true if any token needs funding */
  needsTopup: boolean;
}

/** Build a top-up request: for each requested token, compute the shortfall to the target.
 *  Balances are read by the caller (on-chain) and passed in — this stays pure/testable. */
export function buildTopupRequest(
  agentAddress: string,
  policy: Policy,
  balance: (token: string) => string,
  targets: TopupTarget[],
): TopupRequest {
  const lines: TopupRequestLine[] = targets.map((t) => {
    const token = t.token.toLowerCase();
    const bal = big(balance(token));
    const reserve = big(policy.subscriptionReserve[token] ?? '0');
    const spendable = bal - reserve < 0n ? 0n : bal - reserve;
    const shortfall = big(t.target) - bal;
    return {
      token,
      symbol: policy.allowlist[token]?.symbol ?? '?',
      balance: bal.toString(),
      reserve: reserve.toString(),
      spendable: spendable.toString(),
      shortfall: (shortfall > 0n ? shortfall : 0n).toString(),
    };
  });
  return { agentAddress, lines, needsTopup: lines.some((l) => l.shortfall !== '0') };
}
