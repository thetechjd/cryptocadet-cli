import { describe, it, expect } from 'vitest';
import { buildTopupRequest } from '../src/topup/topup.js';
import { policyWithUsdc, USDC } from './helpers/fixtures.js';

describe('topup:request (human-approved, no auto-drain)', () => {
  it('computes per-token shortfall to the target and the spendable view', () => {
    // balance 30 USDC, reserve 20 => spendable 10. Target 100 => shortfall 70.
    const r = buildTopupRequest('0xagent', policyWithUsdc(), () => '30000000', [{ token: USDC, target: '100000000' }]);
    expect(r.needsTopup).toBe(true);
    expect(r.lines[0]).toMatchObject({
      token: USDC,
      symbol: 'USDC',
      balance: '30000000',
      reserve: '20000000',
      spendable: '10000000',
      shortfall: '70000000',
    });
  });

  it('reports no top-up needed when balance already meets target', () => {
    const r = buildTopupRequest('0xagent', policyWithUsdc(), () => '120000000', [{ token: USDC, target: '100000000' }]);
    expect(r.needsTopup).toBe(false);
    expect(r.lines[0]?.shortfall).toBe('0');
  });

  it('is multi-asset (independent per-token math)', () => {
    const OTHER = '0x9999999999999999999999999999999999999999';
    const policy = policyWithUsdc({
      allowlist: {
        [USDC]: { symbol: 'USDC', decimals: 6, feeOnTransfer: false },
        [OTHER]: { symbol: 'OTH', decimals: 18, feeOnTransfer: false },
      },
      subscriptionReserve: { [USDC]: '20000000' },
    });
    const bal: Record<string, string> = { [USDC]: '30000000', [OTHER]: '5' };
    const r = buildTopupRequest('0xagent', policy, (t) => bal[t] ?? '0', [
      { token: USDC, target: '50000000' },
      { token: OTHER, target: '10' },
    ]);
    expect(r.lines.find((l) => l.token === USDC)?.shortfall).toBe('20000000');
    expect(r.lines.find((l) => l.token === OTHER)?.shortfall).toBe('5');
  });
});
