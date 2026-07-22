import { describe, it, expect } from 'vitest';
import { Ledger } from '../src/ledger/ledger.js';
import { reconcilePending } from '../src/signer/reconcile.js';
import { USDC, SELLER } from './helpers/fixtures.js';

describe('Ledger', () => {
  it('isQuoteSeen / get across statuses', () => {
    const l = new Ledger({ path: ':memory:' });
    expect(l.isQuoteSeen('a')).toBe(false);
    l.markPending({ quoteId: 'a', token: USDC, recipient: SELLER, amount: '5' });
    expect(l.isQuoteSeen('a')).toBe(true);
    expect(l.get('a')?.status).toBe('PENDING');
    l.markConfirmed('a', '0xabc');
    expect(l.get('a')?.status).toBe('CONFIRMED');
    expect(l.get('a')?.tx_hash).toBe('0xabc');
  });

  it('spentLast24h sums only CONFIRMED in the trailing 24h', () => {
    let now = 1_000_000_000_000;
    const l = new Ledger({ path: ':memory:', now: () => now });
    l.markPending({ quoteId: 'x', token: USDC, recipient: SELLER, amount: '1000000' });
    l.markConfirmed('x', '0x1');
    l.markPending({ quoteId: 'y', token: USDC, recipient: SELLER, amount: '2000000' });
    l.markConfirmed('y', '0x2');
    expect(l.spentLast24h(USDC)).toBe('3000000');
    // PENDING is excluded.
    l.markPending({ quoteId: 'z', token: USDC, recipient: SELLER, amount: '9000000' });
    expect(l.spentLast24h(USDC)).toBe('3000000');
    // Advance > 24h: prior confirmations age out.
    now += 25 * 60 * 60 * 1000;
    expect(l.spentLast24h(USDC)).toBe('0');
  });

  it('duplicate quote insert throws (PK guard)', () => {
    const l = new Ledger({ path: ':memory:' });
    l.markPending({ quoteId: 'd', token: USDC, recipient: SELLER, amount: '1' });
    expect(() => l.markPending({ quoteId: 'd', token: USDC, recipient: SELLER, amount: '1' })).toThrow();
  });

  it('markConfirmed leaves finalized_at NULL until markFinalized; awaitingFinalize reflects it', () => {
    const l = new Ledger({ path: ':memory:' });
    l.markPending({ quoteId: 'f', token: USDC, recipient: SELLER, amount: '1' });
    l.markConfirmed('f', '0xabc');
    expect(l.get('f')?.finalized_at).toBeNull();
    expect(l.awaitingFinalize().map((r) => r.quote_id)).toEqual(['f']);
    l.markFinalized('f');
    expect(l.get('f')?.finalized_at).not.toBeNull();
    expect(l.awaitingFinalize()).toHaveLength(0);
  });
});

// 12. Crash mid-payment: PENDING row reconciled from chain, not re-paid.
describe('reconcilePending (case 12)', () => {
  function fakeProvider(receipts: Record<string, { status: number; confirmations: number } | null>) {
    return {
      async getTransactionReceipt(hash: string) {
        const r = receipts[hash];
        if (!r) return null;
        return { status: r.status, confirmations: async () => r.confirmations };
      },
    } as unknown as import('ethers').JsonRpcProvider;
  }

  it('confirmed on-chain tx -> CONFIRMED, finalize called, never re-broadcast', async () => {
    const l = new Ledger({ path: ':memory:' });
    l.markPending({ quoteId: 'p1', token: USDC, recipient: SELLER, amount: '1000000' });
    l.attachTxHash('p1', '0xlanded');
    const finalized: string[] = [];
    const reports = await reconcilePending(l, fakeProvider({ '0xlanded': { status: 1, confirmations: 5 } }), 3, async (q) => {
      finalized.push(q);
    });
    expect(reports).toEqual([{ quoteId: 'p1', outcome: 'confirmed' }]);
    expect(l.get('p1')?.status).toBe('CONFIRMED');
    expect(finalized).toEqual(['p1']);
  });

  it('reverted tx -> FAILED', async () => {
    const l = new Ledger({ path: ':memory:' });
    l.markPending({ quoteId: 'p2', token: USDC, recipient: SELLER, amount: '1' });
    l.attachTxHash('p2', '0xrevert');
    await reconcilePending(l, fakeProvider({ '0xrevert': { status: 0, confirmations: 5 } }), 3);
    expect(l.get('p2')?.status).toBe('FAILED');
  });

  it('unknown/dropped tx -> stays PENDING (no re-sign)', async () => {
    const l = new Ledger({ path: ':memory:' });
    l.markPending({ quoteId: 'p3', token: USDC, recipient: SELLER, amount: '1' });
    l.attachTxHash('p3', '0xunknown');
    const reports = await reconcilePending(l, fakeProvider({ '0xunknown': null }), 3);
    expect(reports[0]?.outcome).toBe('still-pending');
    expect(l.get('p3')?.status).toBe('PENDING');
  });

  it('pending row with no tx hash -> FAILED (never went out)', async () => {
    const l = new Ledger({ path: ':memory:' });
    l.markPending({ quoteId: 'p4', token: USDC, recipient: SELLER, amount: '1' });
    const reports = await reconcilePending(l, fakeProvider({}), 3);
    expect(reports[0]?.outcome).toBe('no-txhash');
    expect(l.get('p4')?.status).toBe('FAILED');
  });

  // Ticket #252: a CONFIRMED-on-chain row whose finalize failed earlier must be re-driven
  // to finalize so RetroDeck can finally observe it and credit the balance.
  it('re-drives a CONFIRMED-but-not-finalized row and finalizes it', async () => {
    const l = new Ledger({ path: ':memory:' });
    l.markPending({ quoteId: 'p5', token: USDC, recipient: SELLER, amount: '1000000' });
    l.markConfirmed('p5', '0xdeep'); // finalize never succeeded -> finalized_at NULL
    const finalized: string[] = [];
    const reports = await reconcilePending(l, fakeProvider({}), 3, async (q) => {
      finalized.push(q);
    });
    expect(finalized).toEqual(['p5']);
    expect(reports).toContainEqual({ quoteId: 'p5', outcome: 'finalized' });
    expect(l.get('p5')?.finalized_at).not.toBeNull();
  });

  it('finalize still failing leaves the row awaiting finalize for a later run', async () => {
    const l = new Ledger({ path: ':memory:' });
    l.markPending({ quoteId: 'p6', token: USDC, recipient: SELLER, amount: '1000000' });
    l.markConfirmed('p6', '0xstillshallow');
    const reports = await reconcilePending(l, fakeProvider({}), 3, async () => {
      throw new Error('VERIFY_FAILED');
    });
    expect(reports).toContainEqual({ quoteId: 'p6', outcome: 'finalize-retry-failed' });
    expect(l.get('p6')?.finalized_at).toBeNull();
    expect(l.awaitingFinalize().map((r) => r.quote_id)).toContain('p6');
  });
});
