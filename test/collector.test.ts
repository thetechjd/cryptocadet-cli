import { describe, it, expect, vi } from 'vitest';
import { executePull, runCollectorOnce, type ExecutorDeps, type PullInstruction } from '../src/collector/executor.js';
import { USDC } from './helpers/fixtures.js';

const COLLECTOR = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const PAYOUT = '0x3333333333333333333333333333333333333333';

function ins(over: Partial<PullInstruction> = {}): PullInstruction {
  return {
    id: 'pull-1',
    subscriptionId: 'sub-1',
    periodIndex: 0,
    chainId: 8453,
    token: USDC,
    from: BUYER,
    to: PAYOUT,
    spender: COLLECTOR,
    amount: '1000000',
    ...over,
  };
}

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    collectorAddress: COLLECTOR,
    chainId: 8453,
    readAllowance: async () => '5000000',
    transferFrom: async () => ({ txHash: '0xpull' }),
    ...over,
  };
}

describe('executePull (collector, fail-closed)', () => {
  it('signs transferFrom when allowance covers the amount', async () => {
    const transferFrom = vi.fn(async () => ({ txHash: '0xpull' }));
    const out = await executePull(deps({ transferFrom }), ins());
    expect(out).toEqual({ ok: true, txHash: '0xpull' });
    expect(transferFrom).toHaveBeenCalledWith(USDC, BUYER, PAYOUT, '1000000');
  });

  it('refuses (no signature) when allowance is below the amount', async () => {
    const transferFrom = vi.fn(async () => ({ txHash: '0x' }));
    const out = await executePull(deps({ readAllowance: async () => '999999', transferFrom }), ins());
    expect(out).toMatchObject({ ok: false });
    expect((out as { reason: string }).reason).toMatch(/insufficient allowance/);
    expect(transferFrom).not.toHaveBeenCalled();
  });

  it('refuses an instruction addressed to a different collector', async () => {
    const transferFrom = vi.fn(async () => ({ txHash: '0x' }));
    const out = await executePull(deps({ transferFrom }), ins({ spender: '0x9999999999999999999999999999999999999999' }));
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/not addressed to this collector/) });
    expect(transferFrom).not.toHaveBeenCalled();
  });

  it('refuses a wrong-chain instruction', async () => {
    const out = await executePull(deps(), ins({ chainId: 84532 }));
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/wrong chain/) });
  });

  it('reports a transferFrom failure as a refusal, not a crash', async () => {
    const out = await executePull(deps({ transferFrom: async () => { throw new Error('reverted'); } }), ins());
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/transferFrom failed/) });
  });
});

describe('runCollectorOnce', () => {
  it('executes each pending pull and reports the result', async () => {
    const reports: Array<{ id: string; result: unknown }> = [];
    const client = {
      pending: async () => [ins({ id: 'a' }), ins({ id: 'b', amount: '99999999' })], // b exceeds allowance
      report: async (id: string, result: unknown) => {
        reports.push({ id, result });
        return {};
      },
    };
    const summary = await runCollectorOnce(client, deps({ readAllowance: async () => '5000000' }));
    expect(summary).toEqual({ claimed: 2, executed: 1, failed: 1 });
    expect(reports.find((r) => r.id === 'a')?.result).toEqual({ txHash: '0xpull' });
    expect(reports.find((r) => r.id === 'b')?.result).toMatchObject({ reason: expect.stringMatching(/allowance/) });
  });
});
