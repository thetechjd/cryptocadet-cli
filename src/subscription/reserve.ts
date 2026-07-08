// reserve:check — the subscription floor only works if per-call refuses to cross it
// (enforced in evaluate() step 6) AND the reserve is actually large enough to cover the
// next pull. This compares, per token, the configured subscriptionReserve against the
// next upcoming pull amount and recent per-call velocity, and warns if the float cannot
// cover both.
//
// Pure and synchronous: balances + 24h spend are read by the caller and passed in. Next
// pull amounts are provided by the caller (there is no locally cached server state — the
// human supplies expected pulls, or a future subscription module feeds them in).

import type { Policy } from '../types/policy.js';

const big = (s: string) => BigInt(s);

export interface ReserveInputs {
  policy: Policy;
  balance: (token: string) => string; // base units
  spentLast24h: (token: string) => string; // base units
  /** token -> next subscription pull amount, base units. Tokens with no pull may omit. */
  nextPull: Record<string, string>;
}

export interface ReserveWarning {
  token: string;
  reason: string;
}

export interface ReserveCheckResult {
  ok: boolean;
  warnings: ReserveWarning[];
}

export function reserveCheck(input: ReserveInputs): ReserveCheckResult {
  const warnings: ReserveWarning[] = [];
  const p = input.policy;
  const tokens = new Set<string>([
    ...Object.keys(p.subscriptionReserve),
    ...Object.keys(input.nextPull),
    ...Object.keys(p.allowlist),
  ]);

  for (const token of tokens) {
    const reserve = big(p.subscriptionReserve[token] ?? '0');
    const pull = big(input.nextPull[token] ?? '0');
    const balance = big(input.balance(token));
    const velocity = big(input.spentLast24h(token));

    // 1. Reserve must cover at least the next pull.
    if (pull > 0n && reserve < pull) {
      warnings.push({
        token,
        reason: `reserve ${reserve} < next pull ${pull}: subscription could fail`,
      });
    }

    // 2. The float must cover BOTH the next pull and recent per-call velocity. If
    //    balance can't simultaneously hold the reserve and sustain observed spend,
    //    a top-up is needed before either bucket runs dry.
    const spendable = balance - reserve;
    if (spendable < 0n) {
      warnings.push({ token, reason: `balance ${balance} is below reserve ${reserve}` });
    } else if (velocity > 0n && spendable < velocity) {
      warnings.push({
        token,
        reason: `spendable ${spendable} < recent 24h velocity ${velocity}: per-call may stall before reserve refills`,
      });
    }
  }

  return { ok: warnings.length === 0, warnings };
}
