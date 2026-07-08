import { describe, it, expect } from 'vitest';
import { buildBalanceSnapshots, buildTopupAlerts } from '../src/dashboard/sync.js';
import { policyWithUsdc, USDC } from './helpers/fixtures.js';

describe('dashboard:sync snapshot builders', () => {
  it('builds per-token balance snapshots; spendable = balance - reserve', () => {
    // fixtures reserve is 20 USDC (20000000).
    const snaps = buildBalanceSnapshots(policyWithUsdc(), { [USDC]: '30000000' });
    expect(snaps).toEqual([
      { token: USDC, symbol: 'USDC', decimals: 6, balance: '30000000', reserve: '20000000', spendable: '10000000' },
    ]);
  });

  it('floors spendable at 0 when balance is below reserve', () => {
    const snaps = buildBalanceSnapshots(policyWithUsdc(), { [USDC]: '5000000' });
    expect(snaps[0]?.spendable).toBe('0');
  });

  it('raises a low-float alert (shortfall = reserve - balance) when below reserve', () => {
    const snaps = buildBalanceSnapshots(policyWithUsdc(), { [USDC]: '5000000' });
    expect(buildTopupAlerts(snaps, '0xAgent')).toEqual([
      { token: USDC, symbol: 'USDC', agentAddress: '0xAgent', shortfall: '15000000' },
    ]);
  });

  it('raises no alert when balance covers the reserve', () => {
    const snaps = buildBalanceSnapshots(policyWithUsdc(), { [USDC]: '25000000' });
    expect(buildTopupAlerts(snaps, '0xAgent')).toEqual([]);
  });

  it('treats a missing balance as 0 (full reserve shortfall)', () => {
    const snaps = buildBalanceSnapshots(policyWithUsdc(), {});
    expect(snaps[0]?.balance).toBe('0');
    expect(buildTopupAlerts(snaps, '0xAgent')[0]?.shortfall).toBe('20000000');
  });
});
