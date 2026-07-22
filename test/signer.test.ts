import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentSigner, type SignerDeps } from '../src/signer/signer.js';
import { Ledger } from '../src/ledger/ledger.js';
import { policyWithUsdc, USDC, SELLER, ATTACKER, recordingBroadcaster } from './helpers/fixtures.js';
import { makeTestQuoteSigner, makeQuote } from './helpers/quote-signer.js';

const server = makeTestQuoteSigner();

function build(over: Partial<SignerDeps> = {}) {
  const ledger = new Ledger({ path: ':memory:' });
  const rec = recordingBroadcaster();
  let finalized: Array<{ quoteId: string; txHash: string }> = [];
  const signer = new PaymentSigner({
    policy: policyWithUsdc(),
    serverQuotePubKey: server.publicKeyB64,
    confirmations: 1,
    ledger,
    readBalance: async () => '100000000', // 100 USDC
    broadcast: rec.broadcast,
    finalize: async (q, t) => {
      finalized.push({ quoteId: q, txHash: t });
    },
    ...over,
  });
  return { signer, ledger, rec, finalized: () => finalized };
}

describe('PaymentSigner — full flow', () => {
  it('signs and confirms a clean in-policy quote (single signature)', async () => {
    const { signer, rec, finalized } = build();
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000' }));
    const r = await signer.pay(q);
    expect(r.status).toBe('CONFIRMED');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({ token: USDC, amount: '1000000' });
    expect(finalized()).toHaveLength(1);
  });

  it('records finalized_at once the server finalize succeeds', async () => {
    const { signer, ledger } = build();
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000', quoteId: 'fin-1' }));
    const r = await signer.pay(q);
    expect(r.status).toBe('CONFIRMED');
    const row = ledger.get('fin-1');
    expect(row?.status).toBe('CONFIRMED');
    expect(row?.finalized_at).not.toBeNull();
    // A finalized row is not awaiting finalize.
    expect(ledger.awaitingFinalize().map((r) => r.quote_id)).not.toContain('fin-1');
  });

  it('on-chain confirmed but finalize failure leaves finalized_at NULL for reconcile retry', async () => {
    // Mirrors the Ticket #252 case: the tx settled but the server rejected finalize (too
    // shallow). The row must stay CONFIRMED yet awaiting finalize so startup reconcile
    // retries and the balance eventually gets credited.
    const { signer, ledger } = build({
      finalize: async () => {
        throw new Error('VERIFY_FAILED: insufficient confirmations');
      },
    });
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000', quoteId: 'fin-2' }));
    const r = await signer.pay(q);
    expect(r.status).toBe('CONFIRMED'); // the money DID land
    const row = ledger.get('fin-2');
    expect(row?.status).toBe('CONFIRMED');
    expect(row?.finalized_at).toBeNull();
    expect(ledger.awaitingFinalize().map((r) => r.quote_id)).toContain('fin-2');
  });

  it('5. repeat pay(quoteId) -> no second signature; returns prior result', async () => {
    const { signer, rec } = build();
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000', quoteId: 'dup-1' }));
    const first = await signer.pay(q);
    expect(first.status).toBe('CONFIRMED');
    const second = await signer.pay(q);
    expect(second.status).toBe('DUPLICATE');
    expect(rec.calls).toHaveLength(1); // NOT 2 — no re-sign
  });

  it('6. invalid serverSig -> REFUSED before policy, no signature', async () => {
    const { signer, rec } = build();
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000' }));
    q.serverSig = Buffer.from('0'.repeat(128), 'hex').toString('base64'); // 64 zero bytes
    const r = await signer.pay(q);
    expect(r.status).toBe('REFUSED');
    expect(rec.calls).toHaveLength(0);
  });

  it('6b. expired quote -> REFUSED before policy', async () => {
    const { signer, rec } = build();
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000', expiresAt: 1 }));
    const r = await signer.pay(q);
    expect(r).toMatchObject({ status: 'REFUSED' });
    expect(rec.calls).toHaveLength(0);
  });

  it('7. forged quote (valid sig) with attacker recipient -> REFUSED at policy, no signature', async () => {
    // Even a perfectly-signed quote is refused if recipient is not allowlisted.
    const { signer, rec } = build();
    const q = server.signQuote(makeQuote({ token: USDC, recipient: ATTACKER, amount: '1000000' }));
    const r = await signer.pay(q);
    expect(r.status).toBe('REFUSED');
    expect(rec.calls).toHaveLength(0);
  });

  it('8. above human-confirm threshold -> ESCALATE, no signature until human approves', async () => {
    const { signer, rec } = build();
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '6000000', quoteId: 'esc-1' }));
    const r = await signer.pay(q);
    expect(r.status).toBe('ESCALATE');
    expect(rec.calls).toHaveLength(0);

    // Human approves out-of-band -> now it signs exactly once.
    const r2 = await signer.pay(q, { humanApproved: true });
    expect(r2.status).toBe('CONFIRMED');
    expect(rec.calls).toHaveLength(1);
  });

  it('humanApproved cannot rescue a non-escalation denial (attacker recipient)', async () => {
    const { signer, rec } = build();
    const q = server.signQuote(makeQuote({ token: USDC, recipient: ATTACKER, amount: '1000000' }));
    const r = await signer.pay(q, { humanApproved: true });
    expect(r.status).toBe('REFUSED');
    expect(rec.calls).toHaveLength(0);
  });

  it('broadcast failure marks FAILED, not a silent retry', async () => {
    const ledger = new Ledger({ path: ':memory:' });
    const rec = recordingBroadcaster({ throwOnSend: true });
    const signer = new PaymentSigner({
      policy: policyWithUsdc(),
      serverQuotePubKey: server.publicKeyB64,
      confirmations: 1,
      ledger,
      readBalance: async () => '100000000',
      broadcast: rec.broadcast,
      finalize: async () => {},
    });
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000', quoteId: 'fail-1' }));
    const r = await signer.pay(q);
    expect(r.status).toBe('FAILED');
    expect(ledger.get('fail-1')?.status).toBe('FAILED');
  });

  it('13. dry_run broadcasts nothing and reports the tx that would be signed', async () => {
    const { signer, rec } = build();
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000' }));
    const r = await signer.dryRun(q);
    expect(r.decision).toEqual({ allow: true });
    expect(r.wouldSign).toMatchObject({ token: USDC, amount: '1000000' });
    expect(rec.calls).toHaveLength(0);
  });

  it('marks PENDING before broadcast (crash-safety ordering)', async () => {
    // confirmation never resolves -> result is PENDING with a tx hash recorded.
    const ledger = new Ledger({ path: ':memory:' });
    const broadcast = async () => ({ txHash: '0xpending', wait: () => new Promise<'confirmed' | 'failed'>(() => {}) });
    const signer = new PaymentSigner({
      policy: policyWithUsdc(),
      serverQuotePubKey: server.publicKeyB64,
      confirmations: 1,
      ledger,
      readBalance: async () => '100000000',
      broadcast,
      finalize: async () => {},
    });
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1000000', quoteId: 'pend-1' }));
    const p = signer.pay(q);
    // The PENDING row must exist essentially immediately (before confirmation).
    await new Promise((r) => setTimeout(r, 10));
    expect(ledger.get('pend-1')?.status).toBe('PENDING');
    expect(ledger.get('pend-1')?.tx_hash).toBe('0xpending');
    void p;
  });
});
