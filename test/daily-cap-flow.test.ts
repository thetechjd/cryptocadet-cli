import { describe, it, expect } from 'vitest';
import { PaymentSigner } from '../src/signer/signer.js';
import { Ledger } from '../src/ledger/ledger.js';
import { policyWithUsdc, USDC, SELLER, recordingBroadcaster } from './helpers/fixtures.js';
import { makeTestQuoteSigner, makeQuote } from './helpers/quote-signer.js';

const server = makeTestQuoteSigner();

// 3. Cumulative spend crossing dailyCap is denied AT the crossing tx, end-to-end through
// the real ledger (CONFIRMED amounts accumulate into spentLast24h).
describe('daily cap accumulation across real payments (case 3)', () => {
  it('allows spends up to the cap and denies the one that crosses it', async () => {
    // dailyCap 50 USDC, perTxCap 10 USDC, reserve 20, balance 100, threshold 5 -> use
    // a policy without escalation so we can chain confirmations cleanly.
    const policy = policyWithUsdc({ requireHumanAboveTx: {} });
    const ledger = new Ledger({ path: ':memory:' });
    const rec = recordingBroadcaster();
    const signer = new PaymentSigner({
      policy,
      serverQuotePubKey: server.publicKeyB64,
      confirmations: 1,
      ledger,
      readBalance: async () => '100000000',
      broadcast: rec.broadcast,
      finalize: async () => {},
    });

    // Five 10-USDC payments = 50 (== cap, allowed). The sixth crosses.
    for (let i = 0; i < 5; i++) {
      const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '10000000', quoteId: `day-${i}` }));
      const r = await signer.pay(q);
      expect(r.status).toBe('CONFIRMED');
    }
    expect(ledger.spentLast24h(USDC)).toBe('50000000');

    const crossing = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000', quoteId: 'day-cross' }));
    const denied = await signer.pay(crossing);
    expect(denied).toMatchObject({ status: 'REFUSED', reason: expect.stringMatching(/daily cap/) });
    expect(rec.calls).toHaveLength(5); // the crossing tx was NOT signed
  });
});
