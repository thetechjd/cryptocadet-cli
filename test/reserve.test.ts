import { describe, it, expect } from 'vitest';
import { reserveCheck } from '../src/subscription/reserve.js';
import { policyWithUsdc, USDC } from './helpers/fixtures.js';

describe('reserve:check (subscription floor)', () => {
  it('passes when reserve covers the next pull and spendable covers velocity', () => {
    const res = reserveCheck({
      policy: policyWithUsdc(), // reserve 20 USDC
      balance: () => '100000000', // 100 USDC
      spentLast24h: () => '1000000', // 1 USDC/day velocity
      nextPull: { [USDC]: '15000000' }, // 15 USDC pull < 20 reserve
    });
    expect(res.ok).toBe(true);
  });

  it('warns when reserve is smaller than the next pull', () => {
    const res = reserveCheck({
      policy: policyWithUsdc(),
      balance: () => '100000000',
      spentLast24h: () => '0',
      nextPull: { [USDC]: '25000000' }, // 25 USDC pull > 20 reserve
    });
    expect(res.ok).toBe(false);
    expect(res.warnings[0]?.reason).toMatch(/reserve .* < next pull/);
  });

  it('warns when balance is below the reserve', () => {
    const res = reserveCheck({
      policy: policyWithUsdc(),
      balance: () => '10000000', // 10 USDC, below 20 reserve
      spentLast24h: () => '0',
      nextPull: {},
    });
    expect(res.ok).toBe(false);
    expect(res.warnings.some((w) => /below reserve/.test(w.reason))).toBe(true);
  });

  it('warns when spendable cannot sustain recent velocity', () => {
    const res = reserveCheck({
      policy: policyWithUsdc(), // reserve 20
      balance: () => '22000000', // spendable = 2 USDC
      spentLast24h: () => '5000000', // velocity 5 USDC > spendable 2
      nextPull: {},
    });
    expect(res.ok).toBe(false);
    expect(res.warnings.some((w) => /velocity/.test(w.reason))).toBe(true);
  });
});
