// Canonical serialization of a quote's signed fields. The server signs EXACTLY this
// byte string; the client verifies against EXACTLY this. Any divergence here silently
// breaks provenance verification, so the field order is fixed and explicit — never
// JSON.stringify of the whole object (key order would be implementation-defined).

import type { UnsignedQuote, SignedQuote } from '../types/quote.js';

export function canonicalQuoteBytes(q: UnsignedQuote): Uint8Array {
  // Fixed field order. Amounts/ids are strings; numbers are emitted as decimal integers.
  const canonical = JSON.stringify([
    'cryptocadet.quote.v1',
    q.quoteId,
    q.chainId,
    q.token.toLowerCase(),
    q.recipient,
    q.amount,
    q.purpose,
    q.expiresAt,
  ]);
  return new TextEncoder().encode(canonical);
}

export function stripSig(q: SignedQuote): UnsignedQuote {
  const { serverSig: _serverSig, ...rest } = q;
  return rest;
}
