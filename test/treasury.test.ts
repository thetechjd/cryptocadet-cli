import { describe, it, expect, vi } from 'vitest';
import { executePayout, runTreasuryOnce, type PayoutInstruction, type TreasuryDeps } from '../src/treasury/executor.js';
import { maxPerPayoutFromEnv } from '../src/treasury/serve.js';
import { USDC } from './helpers/fixtures.js';

const SELLER = '0x3333333333333333333333333333333333333333';

function ins(over: Partial<PayoutInstruction> = {}): PayoutInstruction {
  return { id: 'payout-1', accountId: 'acct-1', chainId: 8453, token: USDC, to: SELLER, amount: '3800000', status: 'CLAIMED', ...over };
}

function deps(over: Partial<TreasuryDeps> = {}): TreasuryDeps {
  return {
    chainId: 8453,
    token: USDC,
    maxPerPayout: 1_000_000_000n,
    readBalance: async () => '50000000',
    transfer: async () => ({ txHash: '0xpaid' }),
    ...over,
  };
}

describe('executePayout (treasury, fail-closed)', () => {
  it('sends USDC to the seller when every check passes', async () => {
    const transfer = vi.fn(async () => ({ txHash: '0xpaid' }));
    expect(await executePayout(deps({ transfer }), ins())).toEqual({ ok: true, txHash: '0xpaid' });
    expect(transfer).toHaveBeenCalledWith(USDC, SELLER, '3800000');
  });

  it.each([
    ['wrong chain', ins({ chainId: 84532 }), /wrong chain/],
    ['unexpected token', ins({ token: '0x0000000000000000000000000000000000000001' }), /unexpected token/],
    ['malformed address', ins({ to: '0xnot-an-address' }), /malformed/],
    ['non-positive amount', ins({ amount: '0' }), /non-positive/],
    ['junk amount', ins({ amount: '1.5' }), /bad amount/],
    ['over the safety cap', ins({ amount: '1000000001' }), /per-payout cap/],
  ])('refuses without signing: %s', async (_name, instruction, reason) => {
    const transfer = vi.fn(async () => ({ txHash: '0x' }));
    const out = await executePayout(deps({ transfer }), instruction);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toMatch(reason);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('refuses when the treasury cannot cover the payout', async () => {
    const transfer = vi.fn(async () => ({ txHash: '0x' }));
    const out = await executePayout(deps({ transfer, readBalance: async () => '100' }), ins());
    expect(!out.ok && out.reason).toMatch(/below payout/);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('reports a broadcast-but-unconfirmed transfer as a failure that names the hash', async () => {
    const out = await executePayout(
      deps({ transfer: async () => { throw new Error('broadcast 0xabc but not confirmed: timeout'); } }),
      ins(),
    );
    expect(!out.ok && out.reason).toMatch(/0xabc/);
  });
});

describe('runTreasuryOnce', () => {
  it('claims, pays, and reports each result', async () => {
    const report = vi.fn(async () => ({}));
    const client = { claim: vi.fn(async () => [ins(), ins({ id: 'payout-2', chainId: 1 })]), report };
    const tick = await runTreasuryOnce(client, deps(), 5);
    expect(client.claim).toHaveBeenCalledWith(5);
    expect(tick).toEqual({ claimed: 2, sent: 1, failed: 1 });
    expect(report).toHaveBeenCalledWith('payout-1', { txHash: '0xpaid' });
    expect(report).toHaveBeenCalledWith('payout-2', { reason: expect.stringMatching(/wrong chain/) });
  });
});

describe('maxPerPayoutFromEnv', () => {
  it('defaults to $1,000 and validates overrides', () => {
    expect(maxPerPayoutFromEnv({})).toBe(1_000_000_000n);
    expect(maxPerPayoutFromEnv({ CRYPTOCADET_TREASURY_MAX_PAYOUT: '5000000' })).toBe(5_000_000n);
    expect(() => maxPerPayoutFromEnv({ CRYPTOCADET_TREASURY_MAX_PAYOUT: '-1' })).toThrow();
  });
});
