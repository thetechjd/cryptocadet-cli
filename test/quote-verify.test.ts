import { describe, it, expect } from 'vitest';
import { verifyQuote } from '../src/quote/verify.js';
import { makeTestQuoteSigner, makeQuote } from './helpers/quote-signer.js';
import { USDC, SELLER } from './helpers/fixtures.js';

const server = makeTestQuoteSigner();
const now = 2_000_000_000; // fixed unix seconds

describe('verifyQuote (case 6)', () => {
  it('accepts a valid, unexpired, correctly-signed quote', () => {
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1', expiresAt: now + 100 }));
    expect(verifyQuote(q, { serverQuotePubKey: server.publicKeyB64, now })).toEqual({ ok: true });
  });

  it('rejects an expired quote', () => {
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1', expiresAt: now - 1 }));
    expect(verifyQuote(q, { serverQuotePubKey: server.publicKeyB64, now })).toMatchObject({ ok: false, reason: 'quote expired' });
  });

  it('rejects a tampered amount (signature no longer matches)', () => {
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1', expiresAt: now + 100 }));
    q.amount = '999999999'; // attacker edits the amount post-signing
    expect(verifyQuote(q, { serverQuotePubKey: server.publicKeyB64, now })).toMatchObject({ ok: false, reason: 'invalid serverSig' });
  });

  it('rejects a tampered recipient', () => {
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1', expiresAt: now + 100 }));
    q.recipient = '0x2222222222222222222222222222222222222222';
    expect(verifyQuote(q, { serverQuotePubKey: server.publicKeyB64, now }).ok).toBe(false);
  });

  it('rejects a signature from the wrong key', () => {
    const other = makeTestQuoteSigner();
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1', expiresAt: now + 100 }));
    expect(verifyQuote(q, { serverQuotePubKey: other.publicKeyB64, now }).ok).toBe(false);
  });

  it('rejects a malformed-length signature', () => {
    const q = server.signQuote(makeQuote({ token: USDC, recipient: SELLER, amount: '1', expiresAt: now + 100 }));
    q.serverSig = 'AAAA';
    expect(verifyQuote(q, { serverQuotePubKey: server.publicKeyB64, now })).toMatchObject({ ok: false });
  });
});
