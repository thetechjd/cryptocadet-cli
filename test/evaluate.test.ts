import { describe, it, expect } from 'vitest';
import { evaluate, type PolicyContext } from '../src/policy/evaluate.js';
import type { QuoteForPolicy } from '../src/types/quote.js';
import { policyWithUsdc, USDC, SELLER, ATTACKER } from './helpers/fixtures.js';

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    policy: policyWithUsdc(),
    walletBalance: () => '100000000', // 100 USDC on hand
    spentLast24h: () => '0',
    isQuoteSeen: () => false,
    ...over,
  };
}

function quote(over: Partial<QuoteForPolicy> = {}): QuoteForPolicy {
  return { quoteId: 'q1', token: USDC, recipient: SELLER, amount: '1000000', chainId: 8453, ...over };
}

describe('evaluate() — adversarial, fail-closed', () => {
  it('allows a clean in-policy quote', () => {
    expect(evaluate(quote(), ctx())).toEqual({ allow: true });
  });

  it('1. recipient not in allowlist -> DENY', () => {
    const d = evaluate(quote({ recipient: ATTACKER }), ctx());
    expect(d.allow).toBe(false);
    expect((d as { reason: string }).reason).toMatch(/recipient not allowlisted/);
  });

  it('2. amount above per-tx cap -> DENY', () => {
    const d = evaluate(quote({ amount: '10000001' }), ctx()); // 10 USDC + 1
    expect(d).toMatchObject({ allow: false, reason: 'exceeds per-tx cap' });
  });

  it('3. cumulative spend crossing daily cap -> DENY at the crossing tx', () => {
    // daily cap 50 USDC; already spent 45; per-tx cap is 10 so a 6 USDC tx is under per-tx
    // but crosses the daily cap (45 + 6 > 50).
    const d = evaluate(quote({ amount: '6000000' }), ctx({ spentLast24h: () => '45000000' }));
    expect(d).toMatchObject({ allow: false, reason: 'exceeds daily cap' });
  });

  it('4. amount dipping into subscription reserve -> DENY (the floor)', () => {
    // balance 25 USDC, reserve 20 => spendable 5. A 6 USDC tx would cross the reserve.
    // (per-tx cap is 10, daily fine; only the reserve stops it.)
    const d = evaluate(quote({ amount: '6000000' }), ctx({ walletBalance: () => '25000000' }));
    expect(d).toMatchObject({ allow: false, reason: 'would cross subscription reserve' });
  });

  it('7. forged quote with attacker recipient -> DENY at recipient allowlist', () => {
    const d = evaluate(quote({ recipient: ATTACKER, amount: '1000000' }), ctx());
    expect(d).toMatchObject({ allow: false });
    expect((d as { reason: string }).reason).toMatch(/recipient not allowlisted/);
  });

  it('8. amount above human-confirm threshold -> escalate', () => {
    // threshold 5 USDC; a 6 USDC tx that is otherwise in-policy escalates.
    const d = evaluate(quote({ amount: '6000000' }), ctx({ walletBalance: () => '100000000' }));
    expect(d).toMatchObject({ allow: false, escalate: true });
  });

  it('idempotency: already-seen quote -> DENY', () => {
    expect(evaluate(quote(), ctx({ isQuoteSeen: () => true }))).toMatchObject({ allow: false, reason: 'quote already processed' });
  });

  it('14. wrong chain -> DENY', () => {
    expect(evaluate(quote({ chainId: 84532 }), ctx())).toMatchObject({ allow: false });
  });

  it('token not allowlisted -> DENY', () => {
    expect(evaluate(quote({ token: '0x9999999999999999999999999999999999999999' }), ctx())).toMatchObject({ allow: false });
  });

  it('malformed recipient -> DENY (not a throw)', () => {
    expect(evaluate(quote({ recipient: 'not-an-address' }), ctx())).toMatchObject({ allow: false, reason: 'malformed recipient' });
  });

  it('non-positive / unparseable amount -> DENY', () => {
    expect(evaluate(quote({ amount: '0' }), ctx())).toMatchObject({ allow: false, reason: 'non-positive amount' });
    expect(evaluate(quote({ amount: 'abc' }), ctx())).toMatchObject({ allow: false, reason: 'bad amount' });
  });

  it('fee-on-transfer token in allowlist is still refused', () => {
    const policy = policyWithUsdc({ allowlist: { [USDC]: { symbol: 'USDC', decimals: 6, feeOnTransfer: true } } });
    expect(evaluate(quote(), ctx({ policy }))).toMatchObject({ allow: false });
  });

  it('checksum-case recipient still matches lowercased allowlist', () => {
    // SELLER is checksummed; allowlist holds lowercase. Must still allow.
    expect(evaluate(quote({ recipient: SELLER }), ctx())).toEqual({ allow: true });
  });
});
